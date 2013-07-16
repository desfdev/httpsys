var httpsys = require('./httpsys_native')
    , events = require('events')
    , util = require('util')
    , ServerRequest = require('./ServerRequest')
    , ServerResponse = require('./ServerResponse')
    , Socket = require('./Socket');

function Server() {
    events.EventEmitter.call(this);
}

util.inherits(Server, events.EventEmitter);

Server.prototype.listen = function (port, hostname, callback) {
    if (this._server) 
        throw new Error('The server is already listening. Call close before calling listen again.');

    if (!port || isNaN(+port) && typeof port !== 'string')
        throw new Error('Port must be specified as a positive integer or a full URL specification string.');

    if (typeof port === 'string' && typeof hostname === 'string')
        throw new Error('If port specifies a full URL, hostname cannot be specified.');

    if (typeof hostname === 'function') {
        callback = hostname;
        hostname = '*';
    }
    else if (typeof hostname === 'undefined') {
        hostname = '*';
    }

    if (typeof callback === 'function') {
        this.on('listening', callback);
    }

    var options = {
        url: typeof port === 'string' ? port : (this._scheme + hostname + ':' + port + '/')
    };

    try {
        this._nativeServer = httpsys.httpsys_listen(options);
        this._nativeServer.serverId = httpsys.serverId++;
        httpsys.servers[this._nativeServer.serverId] = this;
    }
    catch (e) {
        throw new Error('Error initializing the HTTP.SYS server. System error ' + e + '.');
    }

    this.emit('listening');

    return this;
};

Server.prototype.close = function () {
    if (this._server) {
        try {
            httpsys.httpsys_stop_listen(this._nativeServer);
        }
        catch (e) {
            throw new Error('Error closing the HTTP.SYS listener. System error ' + e + '.');
        }

        delete httpsys.servers[this._nativeServer.serverId];
        delete this._nativeServer;
        this.emit('close');
    }
};

Server.prototype._dispatch = function (args) {
    if (!args.eventType || !httpsys.nativeEvents[args.eventType])
        throw new Error('Unrecognized eventType: ' + args.eventType);

    return this[httpsys.nativeEvents[args.eventType]](args);
};

Server.prototype._on_error_initializing_request = function(args) {
    // This is a non-recoverable exception. Ignoring this exception would lead to 
    // the server becoming unresponsive due to lack of pending reads. 

    throw new Error('Unable to initiate a new asynchronous receive of an HTTP request against HTTP.SYS. '
        + 'System error ' + args.code + '.');
};

Server.prototype._on_error_new_request = function(args) {
    // The HTTP.SYS operation that was to receive a new HTTP request had failed. This
    // condition is safe to ignore - no JavaScript representation of the request exists yet, 
    // and the failed pending read had already been replaced with a new pending read. 

    this.emit('clientError', new Error('HTTP.SYS receive of a new HTTP request has failed. '
        + 'System errror ' + args.code + '.'));
};

Server.prototype._on_new_request = function(requestContext) {    
    requestContext._reqAsyncPending = false;
    requestContext._resAsyncPending = false;
    requestContext.requestRead = false;
    requestContext.server = this;
    requestContext.headers = {};
    requestContext.statusCode = 200;
    requestContext.reason = 'OK';
    requestContext.noDelay = true;
    requestContext.socket = new Socket(requestContext);
    requestContext.req = new ServerRequest(requestContext.socket);
    requestContext.asyncPending = function (target, value) {

        // For regular HTTP reuests, only one async operation outstanding against HTTP.SYS 
        // per request is allowed. For upgraded HTTP requests, one async operation per each target
        // (req/res) is allowed. 

        if (value === undefined) {
            // For regular HTTP requests, _reqAsyncPending === _resAsyncPending at all times.
            // For upgraded HTTP requests they may differ.
            return requestContext['_' + target + 'AsyncPending'];
        }
        else {
            if (requestContext.upgrade) {
                requestContext['_' + target + 'AsyncPending'] = value;
            }
            else {
                requestContext._reqAsyncPending = requestContext._resAsyncPending = value;
            }
        }
    };

    if (requestContext.req.headers['upgrade']) {
        // This is an upgrade request.

        requestContext.upgrade = true;

        if (this.listeners('upgrade').length > 0) {
            // The 'upgrade' event has a listener. Emit the event. At this point the request 
            // object is not subscribed to socket's data events: application can only read request 
            // data by subscribing to socket events directly.

            this.emit('upgrade', requestContext.req, requestContext.req.socket, new Buffer(0));
            requestContext.asyncPending('req', !requestContext.socket._paused);
        }
        else {
            // The 'upgrade' event is not listened for. Reject the upgrade request. 

            // Prevent the native module from reading request entity body after this function returns.
            requestContext.asyncPending('req', false); 

            // Send a 400 response and drop the TCP connection
            requestContext.statusCode = 400;
            requestContext.disconnect = true;
            httpsys.httpsys_write_headers(requestContext);
        }
    }
    else {
        // This is a non-upgrade request. Create a response object, and subscribe the request object
        // to the data events generated by the socket in order to re-expose them. 
        
        requestContext.res = new ServerResponse(requestContext.socket);
        requestContext.req._subscribe();

        // Generate new request event

        this.emit('request', requestContext.req, requestContext.res);
        requestContext.asyncPending('req', !requestContext.socket._paused);
    }

    return requestContext.asyncPending('req');
};

Server.prototype._notify_error_and_dispose = function (requestContext, target, message) {
    requestContext.asyncPending(target, false);
    requestContext.socket.emit('error', new Error(message + ' System error ' + requestContext.code + '.'));
    requestContext.socket.emit('close', true);
};

Server.prototype._on_error_initializing_read_request_body = function(args) {
    // The headers of the HTTP request had already been read but initializing reading of the 
    // request body failed. Notify application code and clean up managed resources
    // representing the request. Native resources had already been released at this point.

    this._notify_error_and_dispose(args, 'req', 'Error initializing the reading of the request body.');
};

Server.prototype._on_end_request = function(requestContext) {
    requestContext.asyncPending('req', false);
    requestContext.socket._on_end_request();
};

Server.prototype._on_error_read_request_body = function(args) {
    // The headers of the HTTP request had already been read but reading of the 
    // request body failed. Notify application code and clean up managed resources
    // representing the request. Native resources had already been released at this point.

    this._notify_error_and_dispose(args, 'req', 'Error reading the request body.');
};

Server.prototype._on_request_body = function(requestContext) {
    requestContext.asyncPending('req', false);
    requestContext.socket._on_request_body(requestContext);
    requestContext.asyncPending('req', !requestContext.socket._paused);

    return requestContext.asyncPending('req');
};

Server.prototype._on_error_writing = function(args) {
    // The HTTP request had already been fully read but sending of the 
    // response headers and/or body failed. Notify application code and clean up managed resources
    // representing the request. Native resources had already been released at this point.

    this._notify_error_and_dispose(args, 'res', 'Error sending response data.');
};

Server.prototype._on_written = function(requestContext) {
    requestContext.asyncPending('res', false);
    requestContext.socket._on_written();
};

module.exports = Server;