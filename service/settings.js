module.exports = {
    //secret: 'some long secret shared key for authenticating sessions',
    
    sessionLength: 60*60*24, // 24h time out
    port: 8020,
    messageId: 'chat-id', // incrementing unique id for messages
    messageHash: 'chat-message', // prefix for redis chat message store
    history: 'chat-history', // prefix for redis channel history
    subscription: 'chat' // prefix for redis channel subscription
};