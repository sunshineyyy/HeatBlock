/*jshint node:true*/
var http = require('http');
var url  = require('url');
var fs   = require('fs');

exports.HttpEventListener = HttpEventListener;
//html base directory for all html files
var default_html_base = './html';

function HttpEventListener(event_field_name, listen_port) {
  "use strict";
  //
  // A basic http event listener class.
  // Makes an http server that listens for commands of the form
  // ?event_arg=command_name
  // command_name is then parsed out and if it matches an event name
  // in the registered event list the associated callback is called
  //
  // To add an event see addEventHandler
  //
  // event_arg: the string name of the event argument eg 'cmd' for a device
  //            or 'action' for the manager
  // listen_port: the http port that it should listen on.
  //             (binds to all addresses)
  var this_device = this;
  this.events = [];
  this.event_field_name = event_field_name;
  this.html_base = default_html_base;
  
  http.createServer(function(req,res) {
    this_device.manageHTTPRequest(req,res);
  }).listen(listen_port);
  
}
HttpEventListener.prototype.manageHTTPRequest = function(request,response) {
  "use strict";
  //called when an http request happens
  //wrapped up in such a way that 'this' still refers to a device object,
  //as it should.
  //request: http request
  //response: http response
    
  //parse request
  var post_data = new Buffer('');
  var parsedURL = url.parse(request.url,true);
  var req_args = parsedURL.query;
  var eventfn = this.events[req_args[this.event_field_name]];
  var html_base = this.html_base;
  
  var that = this;
  var handle_resp = function(){
    req_args['@post_data'] = post_data;
    req_args['@ip'] = request.connection.remoteAddress;
    //if its an event
    if (typeof(eventfn) === 'function' ) {
      eventfn(req_args, response);
    //if its a bad request
    } else if (req_args[that.event_field_name])   {
      //bad request!
      response.writeHead(400, {'Content-Type': 'text/plain'});
      response.end('bad request');
      console.log('bad req:' + request.url);
    //if its none of the above its probably a file
    } else {
      //replace .. with . in pathname to prevent exploit)
      var path = html_base + parsedURL.pathname.replace(/\.+/g,'.');
      console.log('getting file: ' + path );
      fs.readFile(path,'utf8', function(err,data) {
        if (err) {
          response.writeHead(404, {'Content-Type': 'text/plain'});
          response.end(String(err));
        } else {
          response.writeHead(200, {'Content-Type': getMIMEType(path)});
          response.end(data);
        }
      });
      
      
    }
    
  };
  
  if (request.method === 'POST') {
    request.on('data',function(d){
      post_data = Buffer.concat([post_data,d]);
    });
    request.on('end', handle_resp);
  } else {
    handle_resp();
  }
  
  
};
HttpEventListener.prototype.addEventHandler = function(command_name, handler) {
  "use strict";
  // Adds an event handler.
  //
  // command_name: a string for the given event name
  // handler: a function that handles the event
  //          That function should have the prototype: function(data, response)
  //          data: Object with properties for each argument passed in the url
  //                data has a special property 'post_data' which contains
  //                the post data, if any, from the http POST request.  
  //          response: the http response object used to respond to the request
  //
  var that = this;
  var fn = function(f,r){
    handler.call(that,f,r);
  };
  this.events[command_name] = fn;
};


function getMIMEType(path) {
  "use strict";
  //
  // gets the MIME type of a file based on its extension
  // path: the file's path
  //
  var pattern = /\.([a-z]+)$/i;
  var extension = pattern.exec(path)[1];
  var extensionLUT = {html : 'text/html',
                      js   : 'text/javascript',
                      ico  : 'image/x-icon',
                     };
  
  if (extensionLUT[extension]) {
    return extensionLUT[extension];
  } else {
    return 'text/plain';
  }
  
}
