export const handler = async (event) => {
    console.log("AeroLink Notification Lambda Triggered");
    console.log("Event:", JSON.stringify(event, null, 2));
    
    // Process SNS or direct event payload
    let records = event.Records || [];
    
    for (const record of records) {
        if (record.Sns) {
            const message = JSON.parse(record.Sns.Message);
            console.log(`Processing SNS Message: ${message.type}`);
            
            if (message.type === "FLIGHT_DELAYED") {
                console.log(`Sending SMS to passengers on flight ${message.flightId}`);
            } else if (message.type === "BAGGAGE_SCANNED") {
                console.log(`Sending Push Notification to passenger ${message.passenger} for bag ${message.baggageId}`);
            }
        }
    }
    
    return {
        statusCode: 200,
        body: JSON.stringify({ message: "Notifications processed successfully" })
    };
};
