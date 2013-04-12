// get required libraries
var 
	app = require('http').createServer(handler),
	crypto = require('crypto'),
	io = require('socket.io').listen(app),
	redis = require('redis'),
	url = require('url');

// import settings
var settings = require('./settings');

// start server
app.listen(settings.port);

function historyResponse(historyParts, req, res) {
	if (historyParts.length === 0) {
		res.writeHead(404);
		res.end('A channel needs to be specified');
	} else {
		var channel = historyParts[0];
		var start = 0;
		var stop;

		if (historyParts.length === 1) {
			stop = -1;
		} else {
			stop = parseInt(historyParts[1], 10)-1;
		}

		if (stop < 0 || isNaN(stop)) {
			stop = -1;
		}

		res.writeHead(200);
		var historyClient = redis.createClient();
		historyClient.lrange(settings.history + '-' + channel, start, stop, function(err, result) {
			var i;
			var numCompleted = 0;

			var completed = function() {
				numCompleted++;

				if (numCompleted === result.length) {
					res.end(']\n');
				} else {
					res.write(',\n');
				}
			};

			res.write('[')
			for (i = 0; i < result.length; i++) {
				historyClient.hgetall(settings.messageHash + '-' + result[i], function(err, result) {
					res.write(JSON.stringify(result, null, 2));

					if (req.method === 'DELETE') {
						// remove this entry
						historyClient.del(settings.messageHash + '-' + result[i]);
						// remove message id from the history list
						historyClient.lrem(settings.history + '-' + channel, -1, result[i]);
					}
					completed();
				});
			};

			if (result.length === 0) {
				res.end(']\n');
			}
		});
	}
}

// how to respond to http requests that aren't socket.io
function handler(req, res) {
	var parsedURL = url.parse(req.url, true);
	var pathname = parsedURL.pathname;
	pathname = pathname.replace(/\/+$/, "");

	if (pathname.indexOf('/hmac/') === 0) {
		// reference for creating an hmac
		var hmacParts = pathname.split(/\//).slice(2);

		if (hmacParts.length < 4) {
			res.writeHead(404);
			res.end('Can only create hmac of salt + 3 fields');
		} else {
			res.writeHead(200);	
			res.end(SessionController.createHash(hmacParts[1], hmacParts[2], hmacParts[3], hmacParts[0]));
		}
	} else if (req.url.indexOf('/history/') === 0) {
		var user, channel, issued, signature;
		var historyParts = pathname.split(/\//).slice(2);

		user = parsedURL.query.user;
		channel = historyParts[0];
		issued = parsedURL.query.issued;
		signature = parsedURL.query.signature;

		// retrieve (GET) or purge (DELETE) chat history for a channel
		// /history/channel
		// /history/channel/length oldest to newest from 0 to stopIndex inclusive
		if (!settings.secret) {
			historyResponse(historyParts, req, res);
		} else if (SessionController.checkHash(signature, user, channel, issued)) {
			historyResponse(historyParts, req, res);
		} else {
			res.writeHead(403);
			res.end('Authentication failed');
		}
	} else {
		res.writeHead(200);
		res.end('Connect via client');
	}
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

SessionController.createHash = function(user, channel, issued, salt) {
	var separator = '|';

	// create a hash to verify that the user, channel and issued time are not forged
	return crypto.createHmac('sha256', salt)
		.update(user)
		.update(separator)
		.update(channel)
		.update(separator)
		.update(issued)
		.digest('base64');
};

SessionController.checkHash = function(msgHash, user, channel, issued) {
	// create a hash from the user, channel and issued time
	msgHash = msgHash.replace(/ /, '+'); // in case URL encoding has turned + into space

	var hash = SessionController.createHash(user, channel, issued, settings.secret);

	// ensure issued is a number
	issued = parseInt(issued, 10);
	return (hash === msgHash && (Date.now() - issued) < (settings.sessionLength * 60));
};

SessionController.createSession = function(msg) {
	var sessionController, hash;

	if (settings.secret) {
		// we require authentication (a signature to make sure that we trust the connection info)

		// ensure a calculated hash matches the one that was sent, and that it wasn't issued too long ago
		if (SessionController.checkHash(msg.hash, msg.user, msg.channel, msg.issued)) {
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
};

SessionController.prototype.subscribe = function(socket, joinMsg) {
	var session = this;

	// upon receiving a message on the redis subscription client
	this.sub.on('message', function(channel, message) {
		// pass it on to the socket.io client
		socket.emit(channel, message);
	});

	// upon receiving a new subscription
	this.sub.on('subscribe', function(channel, count) {
		// publish a join message
		var joinMessage = {
			action: 'control',
			user: session.user,
			name: session.name,
			msg: joinMsg,
			timestamp: Date.now()
		};
		session.publish(joinMessage);
	});

	// subscribe to events on this channel
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
		redis_client.rpush(settings.history + '-' + channel, messageId);

		// store the message data by messageId
		for (key in message) {
			if (message.hasOwnProperty(key)) {
				redis_client.hset(settings.messageHash + '-' + messageId, key, message[key].toString());
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
				// not logged in, try to recreate the session
				sessionController = SessionController.createSession(msg);
				socket.set('sessionController', sessionController);

				if (sessionController !== null) {
					sessionController.subscribe(socket, 'rejoin');
				} else {
					socket.emit('error', 'Unable to authenticate');
				}
			}

			// send message
			var reply = {
				action: 'message',
				user: msg.user,
				name: msg.name,
				msg: msg.msg,
				timestamp: Date.now()
			};
			if (sessionController !== null) {
				sessionController.publish(reply);
			}
		});
	});

	socket.on('join', function(data) {
		var msg = JSON.parse(data);
		var sessionController = SessionController.createSession(msg);
		socket.set('sessionController', sessionController);

		if (sessionController !== null) {
			sessionController.subscribe(socket, 'join');
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