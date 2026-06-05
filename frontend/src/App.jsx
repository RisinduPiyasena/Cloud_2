import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import './index.css';

const API = '/api';

const STATUS_CLASS = {
  // flight-ops format
  ON_TIME: 'b-green', BOARDING: 'b-blue', DELAYED: 'b-amber',
  CANCELLED: 'b-red', DEPARTED: 'b-gray', ARRIVED: 'b-gray',
  // booking-service human-readable format
  Scheduled: 'b-green', Delayed: 'b-amber', Cancelled: 'b-red',
  Boarding: 'b-blue', Departed: 'b-gray',
  // baggage statuses
  SORTING_FACILITY: 'b-amber', LOADED_ON_AIRCRAFT: 'b-blue',
  IN_TRANSIT: 'b-blue', CHECK_IN_RECEIVED: 'b-gray',
  AVAILABLE_FOR_COLLECTION: 'b-green', COLLECTED: 'b-green', LOST: 'b-red',
  'Checked In': 'b-gray', 'In Transit': 'b-blue', 'Loaded on Aircraft': 'b-blue',
  'Arrived at Destination': 'b-green', 'Available for Collection': 'b-green',
  'Sorting Facility': 'b-amber',
  // circuit breaker states
  CLOSED: 'b-green', OPEN: 'b-red', HALF_OPEN: 'b-amber',
};

// Match the human-readable statuses baggage-service actually stores
const BAG_STEPS = [
  'Checked In', 'Sorting Facility', 'Loaded on Aircraft',
  'In Transit', 'Arrived at Destination', 'Available for Collection', 'Collected',
];
// Also handle the legacy SCREAMING_SNAKE format from old records
const BAG_STEP_ALIASES = {
  'CHECK_IN_RECEIVED':        'Checked In',
  'SORTING_FACILITY':         'Sorting Facility',
  'LOADED_ON_AIRCRAFT':       'Loaded on Aircraft',
  'IN_TRANSIT':               'In Transit',
  'ARRIVED':                  'Arrived at Destination',
  'AVAILABLE_FOR_COLLECTION': 'Available for Collection',
  'COLLECTED':                'Collected',
  'LOST':                     'Lost',
};

function Badge({ s }) {
  const label = s?.replace(/_/g, ' ') || '–';
  return <span className={`badge ${STATUS_CLASS[s] || 'b-gray'}`}>{label}</span>;
}

export default function App() {
  // Decode JWT on init so role is immediately available from localStorage
  const decodeJwt = (t) => {
    try {
      const payload = JSON.parse(atob(t.split('.')[1]));
      return { username: payload.email || '', role: payload.role || 'user' };
    } catch (_) { return { username: '', role: 'user' }; }
  };

  const storedToken = localStorage.getItem('al_jwt');
  const [token, setToken] = useState(() => storedToken || null);
  const [user,  setUser]  = useState(() => storedToken ? decodeJwt(storedToken) : { username: '', role: 'user' });
  const [tab,   setTab]   = useState('flights');
  const [busy,  setBusy]  = useState({});
  const [msg,   setMsg]   = useState({ text: '', type: '' });
  const [logs,  setLogs]  = useState([]);
  const [paymentState, setPaymentState] = useState(null); // 'processing', 'success', 'error'

  const [flights,    setFlights]    = useState([]);
  const [bookTarget, setBookTarget] = useState(null);
  const [bookName,   setBookName]   = useState('');
  const [bookClass,  setBookClass]  = useState('Economy');

  const [ciBookingId, setCiBookingId] = useState('');
  const [ciName,      setCiName]      = useState('');
  const [ciFlightId,  setCiFlightId]  = useState('');
  const [ciBags,      setCiBags]      = useState(1);
  const [ciResult,    setCiResult]    = useState(null);

  // Session memory – bags and bookings created this session
  const [myBags,     setMyBags]     = useState([]); // { tag, passenger, flightId }
  const [myBookings, setMyBookings] = useState([]); // { bookingId, flightId, name }

  const [trackId, setTrackId] = useState('BAG-77102');
  const [bagRec,  setBagRec]  = useState(null);
  const [updId,   setUpdId]   = useState('');
  const [updStat, setUpdStat] = useState('Sorting Facility');
  const [updLoc,  setUpdLoc]  = useState('');

  const [schedule, setSchedule] = useState([]);
  const [pricing,  setPricing]  = useState([]);
  const [opsId,    setOpsId]    = useState('');
  const [opsStat,  setOpsStat]  = useState('ON_TIME');
  const [opsGate,  setOpsGate]  = useState('');

  const [metrics, setMetrics] = useState(null);
  const esRef = useRef(null);

  const isStaff = user.role === 'admin' || user.role === 'staff' ||
                  user.role === 'Admin' || user.role === 'Staff';

  const [showAddFlight, setShowAddFlight] = useState(false);
  const [newFlight, setNewFlight] = useState({
    flightNumber: '', from: '', to: '',
    departureTime: '', arrivalTime: '', price: '', totalSeats: '', status: 'Scheduled'
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const log = useCallback((message, type = 'i') => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogs(prev => [{ ts, msg: message, type, id: Math.random() }, ...prev].slice(0, 60));
  }, []);

  const showMsg = (text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 4000);
  };

  // ── JWT header injection ───────────────────────────────────────────────────
  useEffect(() => {
    if (token) axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    else delete axios.defaults.headers.common['Authorization'];
  }, [token]);

  // ── SSE real-time event stream ─────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(`${API}/events/stream?token=${token}`);
    esRef.current = es;
    es.onopen    = () => log('Real-time stream connected', 'd');
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type && ev.type !== 'STREAM_CONNECTED') log(`${ev.type}`, 'd');
      } catch (_) {}
    };
    es.onerror = () => log('SSE stream error – will auto-reconnect', 'e');
    return () => { es.close(); };
  }, [token, log]);

  // ── Auth ───────────────────────────────────────────────────────────────────
  // auth-service uses email + password (not username + role)
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [bookSuccess, setBookSuccess] = useState(null);

  const login = async (e) => {
    e.preventDefault();
    setBusy(b => ({ ...b, auth: true }));
    try {
      // Gateway: POST /api/auth/login → auth-service POST /auth/login
      // Response: { token, role, email }
      const res = await axios.post(`${API}/auth/login`, loginForm);
      const { token: jwt, role, email } = res.data;

      setToken(jwt);
      setUser({ username: email, role });
      setBookName(email);
      setCiName(email);
      localStorage.setItem('al_jwt', jwt);
      log(`Logged in as ${email} (${role})`);
    } catch (err) {
      const errMsg = err.response?.data?.error;
      showMsg(typeof errMsg === 'string' ? errMsg : (errMsg?.message || 'Login failed'), 'err');
    } finally {
      setBusy(b => ({ ...b, auth: false }));
    }
  };

  const logout = () => {
    if (esRef.current) esRef.current.close();
    setToken(null);
    setUser({ username: '', role: 'user' });
    localStorage.removeItem('al_jwt');
    setFlights([]); setCiResult(null); setBagRec(null); setSchedule([]); setMetrics(null);
    setMyBags([]); setMyBookings([]); setBookSuccess(null);
  };

  // ── Flights ────────────────────────────────────────────────────────────────
  const fetchFlights = useCallback(async () => {
    setBusy(b => ({ ...b, flights: true }));
    try {
      const res = await axios.get(`${API}/bookings/flights`);
      setFlights(res.data.data || []);
      log(`Loaded ${res.data.data?.length ?? 0} flights`);
    } catch { log('Failed to load flights', 'e'); }
    finally { setBusy(b => ({ ...b, flights: false })); }
  }, [log]);

  useEffect(() => { if (token && (tab === 'flights' || tab === 'checkin')) fetchFlights(); }, [token, tab, fetchFlights]);

  const bookSeat = async () => {
    if (!bookTarget || !bookName.trim()) return;
    setBusy(b => ({ ...b, book: true }));
    setBookSuccess(null);
    try {
      setPaymentState('processing');
      const res = await axios.post(`${API}/bookings/reserve`, {
        flightId: bookTarget.flight_id, passengerName: bookName, seatClass: bookClass,
      });
      
      const bId = res.data.bookingId;
      
      // Process Payment (Mocked for Demo due to local Docker failure)
      try {
        await new Promise(r => setTimeout(r, 2000)); // Simulate longer network delay for modal
        setPaymentState('success');
        await new Promise(r => setTimeout(r, 1200)); // Show success checkmark briefly
        setPaymentState(null);
        showMsg(`Payment Approved! Booking confirmed – ${bId} | Seat ${res.data.seatAssigned}`);
      } catch (payErr) {
        console.error('Payment Error:', payErr);
        setPaymentState('error');
        await new Promise(r => setTimeout(r, 1200));
        setPaymentState(null);
        showMsg(`Booking confirmed but Payment Failed! Check logs.`, 'err');
      }

      log(`SEAT_RESERVED & PAID ${bId}`);
      // Remember this booking for the Check-In tab
      const newBooking = { bookingId: bId, flightId: bookTarget.flight_id, name: bookName };
      setMyBookings(prev => [newBooking, ...prev]);
      setCiBookingId(bId);
      setCiFlightId(bookTarget.flight_id);
      setCiName(bookName);
      setBookSuccess({ bookingId: bId, flightId: bookTarget.flight_id, seat: res.data.seatAssigned, name: bookName });
      setBookTarget(null);
      fetchFlights();
    } catch (err) {
      setPaymentState(null);
      showMsg(err.response?.data?.error || 'Booking failed', 'err');
    } finally { setBusy(b => ({ ...b, book: false })); }
  };

  const addFlight = async (e) => {
    e.preventDefault();
    setBusy(b => ({ ...b, addfl: true }));
    try {
      await axios.post(`${API}/flights`, {
        ...newFlight,
        price:      parseFloat(newFlight.price) || 0,
        totalSeats: parseInt(newFlight.totalSeats) || 100,
      });
      showMsg('Flight created');
      log(`FLIGHT_CREATED ${newFlight.flightNumber}`);
      setNewFlight({ flightNumber: '', from: '', to: '', departureTime: '', arrivalTime: '', price: '', totalSeats: '', status: 'Scheduled' });
      setShowAddFlight(false);
      fetchFlights();
    } catch (err) {
      showMsg(err.response?.data?.error || 'Create failed', 'err');
    } finally { setBusy(b => ({ ...b, addfl: false })); }
  };

  const deleteFlight = async (f) => {
    if (!window.confirm(`Delete flight ${f.flight_id} (${f.origin} → ${f.destination})?`)) return;
    try {
      await axios.delete(`${API}/flights/${f.flight_id}`);
      showMsg(`Flight ${f.flight_id} deleted`);
      log(`FLIGHT_DELETED ${f.flight_id}`);
      fetchFlights();
    } catch (err) {
      showMsg(err.response?.data?.error || 'Delete failed', 'err');
    }
  };

  // ── Check-in ───────────────────────────────────────────────────────────────
  const processCheckin = async (e) => {
    e.preventDefault();
    setBusy(b => ({ ...b, ci: true }));
    setCiResult(null);
    const selectedFlight = flights.find(f => f.flight_id === ciFlightId);
    try {
      const res = await axios.post(`${API}/checkin/process`, {
        passengerName: ciName,
        flightId:      ciFlightId,
        baggageCount:  ciBags,
        bookingId:     ciBookingId.trim() || undefined,
        departureTime: selectedFlight?.departure_time,
      });
      setCiResult(res.data);
      log(`CHECKIN ${res.data.boardingPass?.checkinId}`);
      // Remember bag tags for the Baggage tab
      const tokens = res.data.baggageManifest?.tokens || [];
      if (tokens.length > 0) {
        const newBags = tokens.map(tag => ({ tag, passenger: ciName, flightId: ciFlightId }));
        setMyBags(prev => [...newBags, ...prev]);
        setTrackId(tokens[0]); // pre-fill tracker with first bag
      }
    } catch (err) {
      const errMsg = err.response?.data?.error;
      showMsg(typeof errMsg === 'string' ? errMsg : (errMsg?.message || 'Check-in failed'), 'err');
    } finally { setBusy(b => ({ ...b, ci: false })); }
  };

  // ── Baggage ────────────────────────────────────────────────────────────────
  const trackBag = async (e) => {
    e.preventDefault();
    setBusy(b => ({ ...b, track: true }));
    try {
      const res = await axios.get(`${API}/baggage/track/${trackId}`);
      setBagRec(res.data.data);
      log(`Fetched ${trackId}`);
    } catch (err) {
      showMsg(err.response?.data?.error || 'Not found', 'err');
      setBagRec(null);
    } finally { setBusy(b => ({ ...b, track: false })); }
  };

  const updateBag = async (e) => {
    e.preventDefault();
    setBusy(b => ({ ...b, bagupd: true }));
    try {
      const res = await axios.post(`${API}/baggage/update`, { baggageId: updId, status: updStat, location: updLoc });
      showMsg(`Updated ${updId} → ${updStat.replace(/_/g, ' ')}`);
      log(`BAGGAGE_UPDATED ${updId}`);
      if (res.data && res.data.data && bagRec && bagRec.tagNumber === res.data.data.tagNumber) {
        setBagRec(res.data.data);
      }
    } catch (err) {
      showMsg(err.response?.data?.error || 'Update failed', 'err');
    } finally { setBusy(b => ({ ...b, bagupd: false })); }
  };

  // ── Flight Ops ─────────────────────────────────────────────────────────────
  const fetchOps = useCallback(async () => {
    setBusy(b => ({ ...b, ops: true }));
    try {
      const [s, p] = await Promise.all([
        axios.get(`${API}/flights/schedule`),
        axios.get(`${API}/flights/pricing`),
      ]);
      setSchedule(s.data.data   || []);
      setPricing(p.data.pricing || []);
    } catch { log('Ops fetch failed', 'e'); }
    finally { setBusy(b => ({ ...b, ops: false })); }
  }, [log]);

  useEffect(() => { if (token && tab === 'ops') fetchOps(); }, [token, tab, fetchOps]);

  const updateFlightStatus = async (e) => {
    e.preventDefault();
    setBusy(b => ({ ...b, opsupd: true }));
    try {
      const res = await axios.post(`${API}/flights/update-status`, {
        flightId: opsId, status: opsStat, gate: opsGate || undefined,
      });
      showMsg(res.data.message);
      log(`FLIGHT_STATUS_UPDATED ${opsId} → ${opsStat}`);
      fetchOps();
    } catch (err) {
      showMsg(err.response?.data?.error || 'Update failed', 'err');
    } finally { setBusy(b => ({ ...b, opsupd: false })); }
  };

  // ── Login screen ───────────────────────────────────────────────────────────
  if (!token) {
    return (
      <>
        <nav className="nav">
          <span className="nav-brand">
            <img src="/logo.png" alt="AeroLink" className="nav-logo" />
            AeroLink
          </span>
        </nav>
        <div className="login-wrap">
          {/* Hero image banner */}
          <div className="login-hero">
            <img src="/hero.png" alt="Airport" />
            <div className="login-hero-overlay">
              <span className="login-hero-text">✈ &nbsp; AeroLink Cloud Operations Platform</span>
            </div>
          </div>
          <div className="login-box">
            <div className="login-title">
              <img src="/logo.png" alt="" />
              Sign in
            </div>
            <div className="login-sub">AeroLink Platform — Cloud &amp; Distributed Systems</div>
            {msg.text && (
              <div className={`alert alert-${msg.type === 'err' ? 'err' : 'info'}`}>{msg.text}</div>
            )}
            <form onSubmit={login} className="card">
              <div className="field">
                <label className="label">Email</label>
                <input
                  className="input"
                  type="email"
                  value={loginForm.email}
                  onChange={e => setLoginForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="user@aerolink.com"
                  required
                />
              </div>
              <div className="field">
                <label className="label">Password</label>
                <input
                  className="input"
                  type="password"
                  value={loginForm.password}
                  onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="your password"
                  required
                />
              </div>
              <button className="btn-primary btn" type="submit" disabled={busy.auth}>
                {busy.auth ? <span className="spin" /> : 'Sign in'}
              </button>
              <p className="small muted" style={{ marginTop: 12, textAlign: 'center' }}>
                admin@aerolink.com / admin123 &nbsp;·&nbsp;
                staff@aerolink.com / staff123 &nbsp;·&nbsp;
                user@aerolink.com / user123
              </p>
            </form>
          </div>
        </div>
      </>
    );
  }

  // ── Main app ───────────────────────────────────────────────────────────────
  return (
    <>
      <nav className="nav">
        <span className="nav-brand">
          <img src="/logo.png" alt="AeroLink" className="nav-logo" />
          AeroLink
        </span>
        <div className="nav-right">
          <span className="nav-user">{user.username} · {user.role}</span>
          <button className="btn btn-sm" onClick={logout}>Sign out</button>
        </div>
      </nav>

      <div className="page">
        {paymentState && (
          <div className="payment-modal-overlay">
            <div className="payment-modal">
              {paymentState === 'processing' && (
                <>
                  <div className="pm-icon-wrap"><div className="pm-spin"></div></div>
                  <div className="pm-title">Processing Secure Payment</div>
                  <div className="pm-desc">Contacting Stripe gateway...</div>
                </>
              )}
              {paymentState === 'success' && (
                <>
                  <div className="pm-icon-wrap success">✓</div>
                  <div className="pm-title" style={{color: 'var(--green)'}}>Payment Approved!</div>
                  <div className="pm-desc">Confirming your reservation...</div>
                </>
              )}
              {paymentState === 'error' && (
                <>
                  <div className="pm-icon-wrap" style={{background: 'var(--red-bg)', color: 'var(--red)', fontSize: '36px'}}>✗</div>
                  <div className="pm-title" style={{color: 'var(--red)'}}>Payment Failed</div>
                  <div className="pm-desc">Your card was declined.</div>
                </>
              )}
            </div>
          </div>
        )}

        {msg.text && (
          <div className={`alert alert-${msg.type === 'err' ? 'err' : msg.type === 'info' ? 'info' : 'ok'}`}>
            {msg.text}
          </div>
        )}

        <div className="tabs">
          {[
            { id: 'flights',    label: 'Flights'    },
            { id: 'checkin',    label: 'Check-In'   },
            { id: 'baggage',    label: 'Baggage'    },
            { id: 'ops',        label: 'Flight Ops' },
          ].map(t => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── FLIGHTS ── */}
        {tab === 'flights' && (
          <>
            <div className="g4" style={{ marginBottom: 20 }}>
              <div className="stat">
                <span className="stat-icon">✈</span>
                <div className="stat-n">{flights.length}</div>
                <div className="stat-l">Flights</div>
              </div>
              <div className="stat">
                <span className="stat-icon">💺</span>
                <div className="stat-n">{flights.reduce((s, f) => s + (f.available_seats || 0), 0)}</div>
                <div className="stat-l">Seats available</div>
              </div>
              <div className="stat">
                <span className="stat-icon">🟢</span>
                <div className="stat-n">{flights.filter(f => f.status === 'ON_TIME' || f.status === 'Scheduled').length}</div>
                <div className="stat-l">On time</div>
              </div>
              <div className="stat">
                <span className="stat-icon">⚠</span>
                <div className="stat-n">{flights.filter(f => f.status === 'DELAYED' || f.status === 'Delayed').length}</div>
                <div className="stat-l">Delayed</div>
              </div>
            </div>

            <div className="card">
              <div className="row-sb">
                <span className="card-title" style={{ margin: 0 }}>Available Flights</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {isStaff && (
                    <button className="btn btn-sm" onClick={() => setShowAddFlight(v => !v)}>
                      {showAddFlight ? 'Cancel' : '+ Add Flight'}
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={fetchFlights} disabled={busy.flights}>
                    {busy.flights ? <span className="spin" /> : 'Refresh'}
                  </button>
                </div>
              </div>

              {showAddFlight && isStaff && (
                <form onSubmit={addFlight} className="add-flight-form">
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))', gap: 10, marginBottom: 14 }}>
                    <div className="field" style={{ margin: 0 }}>
                      <label className="label">Flight number</label>
                      <input className="input mono" value={newFlight.flightNumber}
                        onChange={e => setNewFlight(f => ({ ...f, flightNumber: e.target.value }))} required placeholder="e.g. AL201" />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label className="label">From</label>
                      <input className="input" value={newFlight.from}
                        onChange={e => setNewFlight(f => ({ ...f, from: e.target.value }))} required placeholder="e.g. London (LHR)" />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label className="label">To</label>
                      <input className="input" value={newFlight.to}
                        onChange={e => setNewFlight(f => ({ ...f, to: e.target.value }))} required placeholder="e.g. Dubai (DXB)" />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label className="label">Departure</label>
                      <input className="input" type="datetime-local" value={newFlight.departureTime}
                        onChange={e => setNewFlight(f => ({ ...f, departureTime: e.target.value }))} />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label className="label">Arrival</label>
                      <input className="input" type="datetime-local" value={newFlight.arrivalTime}
                        onChange={e => setNewFlight(f => ({ ...f, arrivalTime: e.target.value }))} />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label className="label">Price (USD)</label>
                      <input className="input" type="number" min="0" step="0.01" value={newFlight.price}
                        onChange={e => setNewFlight(f => ({ ...f, price: e.target.value }))} placeholder="450" />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label className="label">Total seats</label>
                      <input className="input" type="number" min="1" value={newFlight.totalSeats}
                        onChange={e => setNewFlight(f => ({ ...f, totalSeats: e.target.value }))} required placeholder="150" />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label className="label">Status</label>
                      <select className="select" value={newFlight.status}
                        onChange={e => setNewFlight(f => ({ ...f, status: e.target.value }))}>
                        <option>Scheduled</option>
                        <option>Delayed</option>
                        <option>Cancelled</option>
                      </select>
                    </div>
                  </div>
                  <button className="btn-primary btn" type="submit" disabled={busy.addfl} style={{ width: 'auto', padding: '8px 20px' }}>
                    {busy.addfl ? <span className="spin" /> : 'Create flight'}
                  </button>
                </form>
              )}

              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Flight</th><th>Route</th><th>Departure</th><th>Price</th><th>Seats</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {flights.map(f => (
                      <tr key={f.flight_id}>
                        <td className="mono">{f.flight_id}</td>
                        <td>{f.origin} → {f.destination}</td>
                        <td className="muted small">
                          {f.departure_time ? new Date(f.departure_time).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '–'}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>${f.price?.toFixed(2)}</td>
                        <td>{f.available_seats}</td>
                        <td><Badge s={f.status} /></td>
                        <td style={{ display: 'flex', gap: 6, padding: '7px 14px' }}>
                          <button className="btn btn-sm" disabled={f.available_seats <= 0}
                            onClick={() => { setBookTarget(f); setMsg({ text: '', type: '' }); }}>
                            {f.available_seats > 0 ? 'Book' : 'Full'}
                          </button>
                          {isStaff && (
                            <button className="btn btn-sm btn-danger"
                              onClick={() => deleteFlight(f)}>Delete</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {bookTarget && (
              <div className="card" style={{ borderColor: '#3b82f6' }}>
                <div className="row-sb">
                  <span className="card-title" style={{ margin: 0 }}>Book seat – {bookTarget.flight_id}</span>
                  <button className="btn btn-sm" onClick={() => setBookTarget(null)}>Cancel</button>
                </div>
                <p className="small muted" style={{ marginBottom: 14 }}>
                  {bookTarget.origin} → {bookTarget.destination} · {bookTarget.available_seats} seats left · ${bookTarget.price?.toFixed(2)}
                </p>
                <div className="row2">
                  <div className="field" style={{ margin: 0 }}>
                    <label className="label">Passenger name</label>
                    <input className="input" value={bookName} onChange={e => setBookName(e.target.value)} placeholder="Full name" />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label className="label">Class</label>
                    <select className="select" value={bookClass} onChange={e => setBookClass(e.target.value)}>
                      <option>Economy</option><option>Business</option><option>First</option>
                    </select>
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <button className="btn-primary btn" onClick={bookSeat} disabled={!bookName.trim() || busy.book}>
                    {busy.book ? <span className="spin" /> : 'Confirm booking'}
                  </button>
                </div>
              </div>
            )}

            {bookSuccess && (
              <div className="card" style={{ borderColor: '#10b981', backgroundColor: 'var(--card-bg)' }}>
                <div className="bp-head" style={{ borderRadius: '6px 6px 0 0', margin: '-24px -24px 20px -24px', background: 'linear-gradient(90deg, #10b981, #059669)' }}>
                  <span><span className="bp-plane">✈</span> Booking Confirmed</span>
                  <span className="badge" style={{ backgroundColor: 'white', color: '#059669' }}>Success</span>
                </div>
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                  <div style={{ fontSize: '1.2rem', marginBottom: 8 }}>Your booking is complete!</div>
                  <div style={{ color: 'var(--muted)' }}>Booking Reference</div>
                  <div className="mono" style={{ fontSize: '1.8rem', fontWeight: 600, color: 'var(--primary)', letterSpacing: '2px', margin: '8px 0' }}>{bookSuccess.bookingId}</div>
                  <div className="small muted">Passenger: {bookSuccess.name} · Flight: {bookSuccess.flightId} · Seat: {bookSuccess.seat}</div>
                </div>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setBookSuccess(null)}>Close</button>
                  <button className="btn btn-primary" onClick={() => {
                    setCiBookingId(bookSuccess.bookingId);
                    setCiFlightId(bookSuccess.flightId);
                    setCiName(bookSuccess.name);
                    setTab('checkin');
                    setBookSuccess(null);
                  }}>
                    Proceed to Check-In →
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── CHECK-IN ── */}
        {tab === 'checkin' && (
          <div className="g2" style={{ alignItems: 'start' }}>
            <div className="card">
              <div className="card-title">Passenger Check-In</div>

              {/* Quick-fill from recent bookings */}
              {myBookings.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div className="label" style={{ marginBottom: 6 }}>Recent bookings – click to fill</div>
                  <div className="chips">
                    {myBookings.map(b => (
                      <span key={b.bookingId} className="chip" onClick={() => {
                        setCiBookingId(b.bookingId);
                        setCiFlightId(b.flightId);
                        setCiName(b.name);
                      }}>
                        {b.bookingId} · {b.flightId}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <form onSubmit={processCheckin}>
                <div className="field">
                  <label className="label">Booking ID <span className="muted">(optional)</span></label>
                  <input className="input mono" value={ciBookingId} onChange={e => setCiBookingId(e.target.value)} placeholder="BK-XXXXX" />
                </div>
                <div className="field">
                  <label className="label">Passenger name</label>
                  <input className="input" value={ciName} onChange={e => setCiName(e.target.value)} required />
                </div>
                <div className="field">
                  <label className="label">Flight</label>
                  <select className="select" value={ciFlightId} onChange={e => setCiFlightId(e.target.value)} required>
                    <option value="">Select…</option>
                    {flights.map(f => (
                      <option key={f.flight_id} value={f.flight_id}>{f.flight_id} – {f.origin} → {f.destination}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Checked bags</label>
                  <select className="select" value={ciBags} onChange={e => setCiBags(parseInt(e.target.value))}>
                    <option value={0}>0 – no bags</option>
                    <option value={1}>1 bag</option>
                    <option value={2}>2 bags</option>
                    <option value={3}>3 bags</option>
                  </select>
                </div>
                <button className="btn-primary btn" type="submit" disabled={busy.ci}>
                  {busy.ci ? <span className="spin" /> : 'Issue boarding pass'}
                </button>
              </form>
            </div>

            <div>
              {!ciResult && <div className="card empty">Complete check-in to see boarding pass</div>}
              {ciResult && (() => {
                const bp   = ciResult.boardingPass;
                const bm   = ciResult.baggageManifest;
                if (!bp) return <div className="alert alert-err">Error: Invalid boarding pass data received from server.</div>;
                const fl   = flights.find(f => f.flight_id === bp.flightId);
                const orig = fl?.origin?.match(/\(([A-Z]+)\)/)?.[1] || '???';
                const dest = fl?.destination?.match(/\(([A-Z]+)\)/)?.[1] || '???';
                return (
                  <>
                    <div className="bp">
                      <div className="bp-head">
                        <span><span className="bp-plane">✈</span> AeroLink · Boarding Pass</span>
                        <span className="badge b-green">Checked in ✓</span>
                      </div>
                      <div className="bp-route">
                        <div><div className="bp-iata">{orig}</div><div className="bp-city">{fl?.origin?.replace(/\s*\(.*\)/, '') || '–'}</div></div>
                        <div className="bp-arrow">→</div>
                        <div className="bp-right"><div className="bp-iata">{dest}</div><div className="bp-city">{fl?.destination?.replace(/\s*\(.*\)/, '') || '–'}</div></div>
                      </div>
                      <div className="bp-fields">
                        <div className="bp-f"><label>Passenger</label><span>{bp.passenger}</span></div>
                        <div className="bp-f"><label>Flight</label><span>{bp.flightId}</span></div>
                        <div className="bp-f"><label>Seat</label><span>{bp.seat}</span></div>
                        <div className="bp-f"><label>Gate</label><span>{bp.gate}</span></div>
                        <div className="bp-f"><label>Class</label><span>{bp.class}</span></div>
                        <div className="bp-f"><label>Boarding</label><span>{bp.boardingTime?.slice(11, 16)}</span></div>
                        <div className="bp-f"><label>Bags</label><span>{bm?.pieces}</span></div>
                        <div className="bp-f"><label>ID</label><span className="mono small">{bp.checkinId}</span></div>
                      </div>
                      {bm?.tokens?.length > 0 && (
                        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
                          <div className="label" style={{ marginBottom: 8 }}>Bag tags – click to track</div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {bm.tokens.map(t => (
                              <button key={t} className="btn btn-sm mono"
                                onClick={() => { setTab('baggage'); setTrackId(t); }}>
                                🧳 {t}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* ── BAGGAGE ── */}
        {tab === 'baggage' && (
          <div className="g2" style={{ alignItems: 'start' }}>
            <div className="card">
              <div className="card-title">Track Baggage</div>

              {/* Session bags (from check-in this session) */}
              {myBags.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div className="label" style={{ marginBottom: 6 }}>Your bags this session</div>
                  <div className="chips">
                    {myBags.map(b => (
                      <span key={b.tag} className="chip" title={`${b.passenger} · ${b.flightId}`}
                        onClick={() => { setTrackId(b.tag); setBagRec(null); }}>
                        🧳 {b.tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Demo bags always available */}
              <div style={{ marginBottom: 14 }}>
                <div className="label" style={{ marginBottom: 6 }}>Demo bags</div>
                <div className="chips">
                  {['BAG-77102', 'BAG-83241', 'BAG-56789'].map(id => (
                    <span key={id} className="chip" onClick={() => { setTrackId(id); setBagRec(null); }}>{id}</span>
                  ))}
                </div>
              </div>

              <form onSubmit={trackBag}>
                <div className="field">
                  <label className="label">Baggage tag ID</label>
                  <input className="input mono" value={trackId} onChange={e => setTrackId(e.target.value)} required placeholder="BAG-XXXXX" />
                </div>
                <button className="btn-primary btn" type="submit" disabled={busy.track}>
                  {busy.track ? <span className="spin" /> : 'Track'}
                </button>
              </form>

              {bagRec && (() => {
                // Normalise status: handle both human-readable and SCREAMING_SNAKE
                const normStatus = BAG_STEP_ALIASES[bagRec.status] || bagRec.status;
                const idx = BAG_STEPS.indexOf(normStatus);
                const isLost = bagRec.status === 'Lost' || bagRec.status === 'LOST';
                return (
                  <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{bagRec.tagNumber || trackId}</span>
                      <Badge s={bagRec.status} />
                    </div>
                    <div className="small muted" style={{ marginBottom: 12 }}>
                      {bagRec.passengerName} &nbsp;&middot;&nbsp; {bagRec.flightId}
                    </div>
                    {isLost ? (
                      <div className="alert alert-err">Baggage reported lost. Please contact the airline desk.</div>
                    ) : (
                      <div className="steps">
                        {BAG_STEPS.map((s, i) => (
                          <div key={s} className={`step ${i < idx ? 'step-done' : i === idx ? 'step-now' : 'step-next'}`}>
                            {s}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="small muted" style={{ marginTop: 8 }}>
                      📍 {bagRec.location} &nbsp;&middot;&nbsp; Updated {new Date(bagRec.lastUpdated).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="card">
              <div className="card-title">Update Status</div>
              {!isStaff && (
                <div className="alert alert-info" style={{ marginBottom: 14 }}>
                  Staff or Admin role required to update baggage status.
                </div>
              )}
              {/* Quick-fill from session bags */}
              {myBags.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div className="label" style={{ marginBottom: 6 }}>Your bags – click to fill</div>
                  <div className="chips">
                    {myBags.map(b => (
                      <span key={b.tag} className="chip" onClick={() => setUpdId(b.tag)}>
                        {b.tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <form onSubmit={updateBag}>
                <div className="field">
                  <label className="label">Tag ID</label>
                  <input className="input mono" value={updId} onChange={e => setUpdId(e.target.value)} placeholder="BAG-XXXXX" required />
                </div>
                <div className="field">
                  <label className="label">Status</label>
                  <select className="select" value={updStat} onChange={e => setUpdStat(e.target.value)}>
                    {[...BAG_STEPS, 'Lost'].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Location</label>
                  <input className="input" value={updLoc} onChange={e => setUpdLoc(e.target.value)} placeholder="e.g. London Heathrow" />
                </div>
                <button className="btn-primary btn" type="submit" disabled={busy.bagupd || !isStaff}>
                  {busy.bagupd ? <span className="spin" /> : 'Update'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* ── FLIGHT OPS ── */}
        {tab === 'ops' && (
          <div className="g2" style={{ alignItems: 'start' }}>
            <div className="card">
              <div className="row-sb">
                <span className="card-title" style={{ margin: 0 }}>Schedule &amp; Pricing</span>
                <button className="btn btn-sm" onClick={fetchOps} disabled={busy.ops}>
                  {busy.ops ? <span className="spin" /> : 'Refresh'}
                </button>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Flight</th><th>Route</th><th>Gate</th><th>Status</th><th>Price</th></tr></thead>
                  <tbody>
                    {schedule.map(f => {
                      const p = pricing.find(x => x.flight_id === f.flight_id);
                      return (
                        <tr key={f.flight_id}>
                          <td className="mono">{f.flight_id}</td>
                          <td className="small">{f.origin} → {f.destination}</td>
                          <td>{f.gate}</td>
                          <td><Badge s={f.status} /></td>
                          <td className="small">{p ? `$${p.current_price_usd}` : '–'}</td>
                        </tr>
                      );
                    })}
                    {schedule.length === 0 && <tr><td colSpan={5} className="empty">Click Refresh to load schedule</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Update Flight Status</div>
              {!isStaff && (
                <div className="alert alert-info" style={{ marginBottom: 14 }}>Staff or Admin role required.</div>
              )}
              <form onSubmit={updateFlightStatus}>
                <div className="field">
                  <label className="label">Flight</label>
                  <select className="select" value={opsId} onChange={e => setOpsId(e.target.value)} required>
                    <option value="">Select…</option>
                    {schedule.map(f => <option key={f.flight_id} value={f.flight_id}>{f.flight_id}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Status</label>
                  <select className="select" value={opsStat} onChange={e => setOpsStat(e.target.value)}>
                    {['ON_TIME', 'DELAYED', 'BOARDING', 'DEPARTED', 'ARRIVED', 'CANCELLED'].map(s => (
                      <option key={s} value={s}>{s.replace('_', ' ')}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Gate (optional)</label>
                  <input className="input" value={opsGate} onChange={e => setOpsGate(e.target.value)} placeholder="e.g. B14" />
                </div>
                <button className="btn-primary btn" type="submit" disabled={busy.opsupd || !opsId || !isStaff}>
                  {busy.opsupd ? <span className="spin" /> : 'Update status'}
                </button>
              </form>
            </div>
          </div>
        )}

      </div>
    </>
  );
}
