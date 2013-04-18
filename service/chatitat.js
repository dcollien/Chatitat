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
console.log('Listening on port ' + settings.port);


function getOnlineUsers(redisClient, channel, callback) {
	// retrieve a list of online users
	redisClient.smembers(settings.userSet + '-' + channel, function(err, members) {
		var onlineUsers = [];
		var i;
		var numCompleted = 0;

		var completed = function() {
			numCompleted++;

			if (numCompleted === members.length) {
				callback(onlineUsers);
			}
		};

		if (!members || members.length === 0) {
			callback([]);
		} else {
			for (i = 0; i != members.length; ++i) {
				var userID = members[i];
				redisClient.hgetall(settings.userSession + '-' + userID + '-' + channel, function(err, userData) {
					onlineUsers.push({
						user: userData.user,
						name: userData.name,
						connectedAt: userData.connectedAt
					});
					completed();
				});
			}
		}
	});
}

function getHistory(historyClient, channel, start, stop, callback, isDeleting) {
	// retrieve the history buffer for a channel
	historyClient.lrange(settings.history + '-' + channel, start, stop, function(err, result) {
		var i;
		var numCompleted = 0;
		var historyList = [];

		var completed = function() {
			numCompleted++;

			if (numCompleted === result.length) {
				callback(historyList);
			}
		};

		if (!result) {
			callback([]);
			return;
		}

		for (i = 0; i != result.length; i++) {
			historyClient.hgetall(settings.messageHash + '-' + result[i], function(err, historyItem) {
				historyList.push(historyItem);

				if (isDeleting) {
					// remove this entry
					historyClient.del(settings.messageHash + '-' + result[i]);
					// remove message id from the history list
					historyClient.lrem(settings.history + '-' + channel, -1, result[i]);
				}
				completed();
			});
		};

		if (result.length === 0) {
			callback(historyList);
		}
	});
}

// responds with a json encoding of the chat history for a channel
function historyResponse(historyParts, req, res) {
	if (historyParts.length === 0) {
		res.writeHead(404);
		res.end('A channel needs to be specified');
	} else {
		// choose the channel and stop index from the path parts
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

		// protected by HMAC signing, can allow any origin
		res.writeHead(200, {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*'
		});

		// create a redis client to connect
		var historyClient = redis.createClient();

		getHistory(historyClient, channel, start, stop, function(result) {
			res.end(JSON.stringify(result, null, 2));
			historyClient.quit();
		}, req.method === 'DELETE');
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
			res.writeHead(200, {
				'Content-Type': 'text/plain',
				'Access-Control-Allow-Origin': '*'
			});
			res.end(SessionController.createHash(hmacParts[1], hmacParts[2], hmacParts[3], hmacParts[0]));
		}
	} else if (pathname.indexOf('/history/') === 0) {
		// report a channel's message history

		var user, channel, issued, signature;
		var historyParts = pathname.split(/\//).slice(2);

		user = parsedURL.query.user;
		channel = historyParts[0];
		issued = parsedURL.query.issued;
		signature = parsedURL.query.signature;

		if (!channel) {
			res.writeHead(404);
			res.end('No channel specified');
		} else {
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
		}
	} else if (pathname.indexOf('/list/') === 0) {
		// list online users
		// /list/channel
		
		var redisClient = redis.createClient();
		var listParts = pathname.split(/\//).slice(2);
		var channel = listParts[0];
		var issued = parsedURL.query.issued;
		var signature = parsedURL.query.signature;

		if (!channel) {
			res.writeHead(404);
			res.end('No channel specified');
			redisClient.quit();
		} else {
			if (!settings.secret) {
				getOnlineUsers(redisClient, channel, function(users) {
					res.writeHead(200, {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					});
					res.end(
						JSON.stringify(users, null, 2)
					);

					redisClient.quit();
				});
			} else if (SessionController.checkHash(signature, user, channel, issued)) {
				getOnlineUsers(redisClient, channel, function(users) {
					res.writeHead(200, {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					});
					res.end(
						JSON.stringify(users, null, 2)
					);

					redisClient.quit();
				});
			} else {
				res.writeHead(403);
				res.end('Authentication failed');
				redisClient.quit();
			}
		}

	} else {
		res.writeHead(200);
		res.end('Connect via a chat client');
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
	this.connectedAt = Date.now();
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
	this.sub.on('message', function(subscription, message) {
		// pass it on to the socket.io client
		socket.emit(subscription, message);
	});

	// upon receiving a new subscription
	this.sub.on('subscribe', function(subscription, count) {
		// publish a join message
		var joinMessage = {
			action: 'control',
			user: session.user,
			name: session.name,
			msg: joinMsg,
			timestamp: Date.now()
		};
		session.publish(joinMessage);
		
		// save session data to redis
		session.pub.hset(settings.userSession + '-' + session.user + '-' + session.channel, 'user', session.user);
		session.pub.hset(settings.userSession + '-' + session.user + '-' + session.channel, 'name', session.name);
		session.pub.hset(settings.userSession + '-' + session.user + '-' + session.channel, 'connectedAt', session.connectedAt.toString());

		// add user to the online list
		session.pub.sadd(settings.userSet + '-' + session.channel, session.user);
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
	this.pub.srem(settings.userSet + '-' + this.channel, this.user);
	this.pub.del(settings.userSession + '-' + this.user + '-' + this.channel);

	if (this.sub !== null) this.sub.quit();
	if (this.pub !== null) this.pub.quit();
};

io.sockets.on('connection', function (socket) {
	// on a socket connecting

	socket.on('chat', function (data) {
		// receiving a chat message
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
		// joining the channel

		var msg = JSON.parse(data);
		var sessionController = SessionController.createSession(msg);
		socket.set('sessionController', sessionController);

		if (sessionController !== null) {
			sessionController.subscribe(socket, 'join');
		} else {
			socket.emit('error', 'Unable to authenticate');
		}
	});

	// on requesting a list of online users in the channel
	socket.on('list', function(data) {
		socket.get('sessionController', function(err, session) {
			// send to the client
			getOnlineUsers(session.pub, session.channel, function(users) {	
				socket.emit(settings.subscription + '-' + session.channel, JSON.stringify({
					action: 'list',
					msg: users
				}));
			});
		});
	});

	// on requesting chat history buffer
	socket.on('history', function(data) {
		socket.get('sessionController', function(err, session) {
			getHistory(session.pub, session.channel, 0, -1, function(result) {
				// send to the client
				socket.emit(settings.subscription + '-' + session.channel, JSON.stringify({
					action: 'history',
					msg: result
				}));
			});
		});
	});

	socket.on('disconnect', function() {
		// disconnect from a socket - might happen quite frequently depending on network quality

		socket.get('sessionController', function(err, sessionController) {
			if (sessionController === null) return;
			sessionController.unsubscribe();
			var leaveMessage = {
				action: 'control',
				name: sessionController.name,
				user: sessionController.user,
				msg: 'disconnect',
				timestamp: Date.now()
			};
			sessionController.publish(leaveMessage);
			sessionController.destroyRedis();
		});
	});
});