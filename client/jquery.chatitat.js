(function($) {
    $.fn.chatitat = function() {
        var container = this;
        var options = arguments[0];

        // handle methods (none)
        if (typeof options === 'string') {
            return this;
        }

        // start Init
        var errorHandler, receiveHandler, sendHandler

        if (!options) {
            throw {
                message: "No options specified"
            };
        }
        if (!options.userID || !options.channel) {
            throw {
                message: "No user ID or channel specified"
            };
        }
        if (!options.host) {
            throw {
                message: "No host specified"
            };
        }

        if (options.errorCallback) {
            errorHandler = options.errorHandler;
        }
        if (options.sendCallback) {
            sendHandler = options.sendCallback;
        }
        if (options.receiveCallback) {
            receiveHandler = options.receiveCallback;
        }
        
        if (!options.rejoinMessage) {
            options.rejoinMessage = ' reconnected.';
        }
        if (!options.joinMessage) {
            options.joinMessage = ' connected.';
        }
        if (!options.disconnectMessage) {
            options.disconnectMessage = ' disconnected.';
        }
        if (!options.userName) {
            options.userName = options.userID;
        }
        if (!options.signature) {
            options.signature = '';
        }

        var $channel = $('<div class="chat-channel"></div>');
        $channel.append(
            $('<div id="msgs" class="chat-messages"></div>').append(
                $('<ul>').append(
                    $('<li class="chat-message"></li>').append(
                        $('<span class="chat-user"></span><span class="chat-message"></span><span class="chat-time"></span>')
                    )
                ).append(
                    $('<li class="chat-control"></li>').append(
                        $('<span class="chat-user"></span>&nbsp;<span class="chat-message"></span><span class="chat-time"></span>')
                    )
                )
            )
        );

        var $input = $('<div></div>');
        $input.append(
            $('<form><textarea id="chat-message-input" class="chat-input"></textarea></form>')
        );

        $channel.append($input);

        container.append($channel);

        var socket = io.connect(options.host, options.io);
        var channel = options.channel;
        var hash = options.signature;
        var name = options.userName;
        var user = options.userID;
        var issued = options.issued;

        // send join message
        socket.emit('join', $.toJSON({
          user: user, 
          name: name,
          channel: channel,
          hash: hash,
          issued: issued
        }));

        socket.on('error', function(msg) {
            if (errorHandler) {
                errorHandler(msg, user, name, channel);
            } else {
                alert(msg);
            }
        });

        // handler for callback
        socket.on('chat-' + channel , function (msg) {
            var message = $.evalJSON(msg);

            if (receiveHandler) {
                receiveHandler(message.msg, message.user, message.name, channel);
            }
            
            var action = message.action;
            var struct = container.find('li.chat-' + action + ':first');
            
            if (struct.length < 1) {
                console && console.log("Could not handle: " + message);
                return;
            }
            
            // get a new message view from struct template
            var messageView = struct.clone();
            messageView.append(
                $('<div style="clear:both"></div>')
            );
            
            // set time
            messageView.find('.chat-time').text((new Date()).toString("HH:mm:ss"));
            
            switch (action) {
                case 'message': 
                    var matches;
                    var messageLines = message.msg.split(/\n/);
                    // someone starts chat with /me ... 
                    if (matches = message.msg.match(/^\s*[\/\\]me\s(.*)/)) {
                        messageView.find('.chat-user').text(message.name + ' ' + matches[1]);
                        messageView.find('.chat-user').css('font-weight', 'bold');
                    // normal chat message                              
                    } else {
                        var messageContainer = messageView.find('.chat-message');
                        messageView.find('.chat-user').text(message.name);
                        messageContainer.text(': ');
                        $.each(messageLines, function(i, val) {
                            messageContainer.append($('<div class="chat-message-line">').text(val));
                        });
                    }
                    break;
                case 'control':
                    messageView.find('.chat-user').text(message.name);
                    
                    if (message.msg === 'join') {
                        messageView.find('.chat-message').text(options.joinMessage);
                    } else if (message.msg === 'rejoin') {
                        messageView.find('.chat-message').text(options.rejoinMessage);
                    } else if (message.msg === 'disconnect') {
                        messageView.find('.chat-message').text(options.disconnectMessage);
                    } else {
                        messageView.find('.chat-message').text(message.msg);
                    }

                    messageView.addClass('chat-control');
                    break;
            }
            
            // color own user:
            if (message.user == user) messageView.find('.chat-user').addClass('chat-self');
            
            // append to container and scroll
            container.find('ul').append(messageView.show());
            container.scrollTop(container.find('ul').innerHeight());
        });

        // new message is sent from the input box
        $input.find('#chat-message-input').keypress(function(event) {
            if (event.which == 13 && !event.ctrlKey) {
                event.stopPropagation();
                $input.find('form').submit();
                return false;
            }
        });

        $input.find('form').submit(function(event) {
          event.preventDefault();
          var input = $(this).find(':input');
          var msg = input.val();
          socket.emit('chat', $.toJSON({
            action: 'message',
            user: user,
            name: name,
            msg: msg,
            channel: channel,
            hash: hash,
            issued: issued
          }));
          
          if (sendHandler) {
            sendHandler(msg, user, name, channel);
          }

          input.val('');
        }); 

        return this;
    };
})(jQuery);