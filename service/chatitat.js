// get required libraries
var 
	app = require('http').createServer(handler),
	Crypto = require('cryptojs').Crypto,
	io = require('socket.io').listen(app),
	redis = require('redis');

// import settings
var settings = require('./settings');

// start server
app.listen(settings.port);

// how to respond to http requests that aren't socket.io
function handler(req, res) {
	res.writeHead(200);
	res.end('Connect via client');
}

// set up socket.io
io.configure(function() {
	io.set('close timeout', settings.sessionLength);
});

// a controller for keeping session information around
function SessionController(userID, userName, channel) {
	// session controller class for storing redis connections
	this.sub = redis.createClient();
	this.pub = redis.createClient();
	
	this.user = userID;
	this.name = userName;
	this.channel = channel;
}

SessionController.createSession = function(msg) {
	var sessionController, hash;

	if (settings.secret) {
		// we require authentication (a signature to make sure that we trust the connection info)

		// create a hash from the user, channel and issued time
		hash = Crypto.HMAC(Crypto.SHA256, msg.user + ',' + msg.channel + ',' + msg.issued, settings.secret);

		// ensure the hash matches the one that was sent, and that it wasn't issued too long ago
		if (hash === msg.hash && (Date.now - msg.sessionIssued) < (settings.sessionLength * 60)) {
			// create a session
			sessionController = new SessionController(msg.user, msg.name, msg.channel);
		} else {
			// didn't pass authentication, no session
			sessionController = null;
		}
	} else {
		// no authentication required, just create the session
		sessionController = new SessionController(msg.user, msg.name, msg.channel);
	}

	return sessionController;
}

SessionController.prototype.subscribe = function(socket) {
	var current = this;

	this.sub.on('message', function(channel, message) {
		socket.emit(channel, message);
	});

	this.sub.on('subscribe', function(channel, count) {
		var joinMessage = JSON.stringify({
			action: 'control',
			user: current.user,
			name: current.name,
			msg: ' came online.'
		});

		current.publish(joinMessage);
	});

	this.sub.subscribe(settings.subscription + '-' + this.channel);
};

SessionController.prototype.rejoin = function(socket, message) {
	this.sub.on('message', function(channel, message) {
		socket.emit(channel, message);
	});

	var current = this;
	this.sub.on('subscribe', function(channel, count) {
		var rejoin = JSON.stringify({
			action: 'control',
			user: current.user,
			name: current.name,
			msg: ' came back online.' }
		);

		current.publish(rejoin);
		var reply = JSON.stringify({
			action: 'message',
			user: message.user,
			name: current.name,
			msg: message.msg
		});
		current.publish(reply);
	});

	this.sub.subscribe(settings.subscription + '-' + this.channel);
};

SessionController.prototype.unsubscribe = function() {
	// unsubscribe from channel
	this.sub.unsubscribe(settings.subscription + '-' + this.channel);
};

SessionController.prototype.publish = function(message) {
	// select the publishing client
	var channel = this.channel;
	var redis_client = this.pub;

	// publish message to subscribing clients
	redis_client.publish(settings.subscription + '-' + channel, JSON.stringify(message));

	// get a new unique message id
	redis_client.incr(settings.messageId, function(err, reply) {
		var messageId = reply.toString();
		var key;

		// push this message to the chat channel history
		redis_client.rpush(settings.history + '-' + channel, messageId, redis.print);
		console.log('RPUSH ' + settings.history + '-' + channel + ' ' + messageId);
		// store the message data by messageId
		for (key in message) {
			if (message.hasOwnProperty(key)) {
				redis_client.hset(settings.messageHash + '-' + messageId, key, message[key].toString(), redis.print);
				console.log('HSET ' + settings.messageHash + '-' + messageId + ' ' + key + ' ' + message[key].toString());
			}
		}
	});
};

SessionController.prototype.destroyRedis = function() {
	if (this.sub !== null) this.sub.quit();
	if (this.pub !== null) this.pub.quit();
};

io.sockets.on('connection', function (socket) {
	// the actual socket callback
	console.log(socket.id);

	socket.on('chat', function (data) {
		// receiving chat messages
		var msg = JSON.parse(data);

		socket.get('sessionController', function(err, sessionController) {
			if (sessionController === null) {
				// not logged in
				var newSessionController = SessionController.createSession(msg);
				socket.set('sessionController', newSessionController);

				if (newSessionController !== null) {
					newSessionController.rejoin(socket, msg);
				} else {
					socket.emit('error', 'Unable to authenticate');
				}
			} else {
				// send message
				var reply = {
					action: 'message',
					user: msg.user,
					name: msg.name,
					msg: msg.msg,
					timestamp: Date.now()
				};
				sessionController.publish(reply);
			}
		});
	});

	socket.on('join', function(data) {
		var msg = JSON.parse(data);
		var sessionController = SessionController.createSession(msg);
		socket.set('sessionController', sessionController);

		if (sessionController !== null) {
			sessionController.subscribe(socket);
		} else {
			socket.emit('error', 'Unable to authenticate');
		}
	});

	socket.on('disconnect', function() { // disconnect from a socket - might happen quite frequently depending on network quality
		socket.get('sessionController', function(err, sessionController) {
			if (sessionController === null) return;
			sessionController.unsubscribe();
			var leaveMessage = JSON.stringify({action: 'control', user: sessionController.user, msg: ' went offline.' });
			sessionController.publish(leaveMessage);
			sessionController.destroyRedis();
		});
	});
});