//
//  Smart heat block nodejs Pi side script.  invoked using nodejs
//

//NODE libraries
var fs     = require('fs');
var OS     = require('os');
var crypto = require('crypto');
var dgram  = require('dgram');
var http   = require('http');
var url    = require('url');
//My libraries
var HEL    = require('./httpEventListener.js').HttpEventListener;
var rSPI   = require('./rSPI');
var led    = require('./controlGPIO/build/Release/led');
var exec   = require('child_process').exec; // used when using python script to control GPIO

var voicejs = require('/home/pi/.npm/voice.js/0.1.3/package/voice.js');
var text = process.argv[4] || 'This is a test sms from voice.js';
var to = process.argv.slice(5).length ?  process.argv.slice(5) : ['2066737490'];

//some parameters.
var app_code_path  = 'app.js';
var html_code_path = 'app.html';
var name           = 'Smart Heat Block';
var keystr = "obqQm3gtDFZdaYlENpIYiKzl+/qARDQRmiWbYhDW9wreM/APut73nnxCBJ8a7PwW";
var client = new voicejs.Client({
    email: process.argv[2] || 'yaoyu.yang88@gmail.com',
    password: process.argv[3] || 'password',
    tokens: require('/home/pi/.npm/voice.js/0.1.3/package/examples/tokens.json')
});

//some global data variables
var resist_array = new Array; //light dependent resistor value array
var temp_array = new Array; //temperature value array
var heater_info = []; //heater on or off info, 1 stands for on, 0 for off.
var temp_rec = 1; // a variable that used to record the starting temperature during an automatic heating process
/////////////////////////////// A basic device /////////////////////////////////
function Device(listen_port) {
  //a basic device.  Many functions are stubs and or return dummy values
  //listen_port: listen for http requests on this port
  //
  HEL.call(this,'cmd',listen_port);
  
  //init device info
  this.port   = listen_port;
  this.status = "ready"; //other options are "logging"
  this.state  = "none"; //no other state for such a simple device
  this.uuid = this.computeUUID();
  
  //some device state
  this.logging_timer = null;
  this.manager_port = null;
  this.manager_IP = null;

  //standard events
  this.addEventHandler('getCode',this.getCodeEvent); 
  this.addEventHandler('getHTML',this.getHTMLEvent); 
  this.addEventHandler('info',this.info);
  this.addEventHandler('ping',this.info);
  this.addEventHandler('acquire',this.acquire);
  
  //implementation specific events
  //TODO: REPLACE THESE TWO EVENTS WITH YOUR OWN
  this.addEventHandler('startLog',this.startLogging);
  this.addEventHandler('stopLog',this.stopLogging);
  this.addEventHandler('heatOn',this.heaton);
  this.addEventHandler('heatOff',this.heatoff);
  this.addEventHandler('heatAutomatic',this.heatpwm);
  this.addEventHandler('heatAutomaticEnd', this.heatAutomaticEnd);
  this.addEventHandler('desiredTemp',this.desiredTemp);
  this.addEventHandler('cellphoneNumber',this.cellphoneNumber);
  //manually attach to manager.
  this.manager_IP = 'bioturk.ee.washington.edu';
  this.manager_port = 9090;
  this.my_IP = OS.networkInterfaces().eth0[0].address;
  this.sendAction('addDevice',
                  {port: listen_port, addr: this.my_IP},
                  function(){});
  
  //advertise that i'm here every 10 seconds until i'm aquired
  /*var this_device = this;
  this.advert_timer = setInterval(function(){
    this_device.advertise('224.250.67.238',17768);
  },10000);*/
}
Device.prototype = Object.create(HEL.prototype);
Device.prototype.constructor = Device;

Device.prototype.advertise = function(mcastAddr,mport) {
  //broadcast on a specified multicast address/port that you exist
  // mcastAddr: the multicast address
  // mport: the port to listen on.
  var p = "00000" + this.port;
  p = p.substr(p.length-5); //zero pad up to 5 chars
  
  var udpsock = dgram.createSocket('udp4');
  udpsock.bind();
  udpsock.setMulticastTTL(10);
  
  var message = new Buffer(keystr+p);
  udpsock.send(message,0,message.length,mport,mcastAddr,
               function(err,bytes){
    udpsock.close();
  });
};
////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////EVENTS////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
Device.prototype.info = function(fields,response) {
  //
  // parses info request
  // fields: the html query fields
  // response: an http.ServerResponse object used to respond to the server
  //
  
  response.writeHead(200, {'Content-Type': 'text/plain'});
  
  response.end(JSON.stringify( {
    uuid   : this.uuid,
    status : this.status,
    state  : this.state,
    name   : name,
    }));
  console.log('waiting for info');
  
};
Device.prototype.acquire = function(fields,response) {
  //
  // set this as acquired
  // fields: the html query fields
  // response: an http.ServerResponse object used to respond to the server
  //
  response.writeHead(200, {'Content-Type': 'text/plain'});
  response.end();
  this.manager_port = parseInt(fields.port,10);
  this.manager_IP  = fields['@ip'] ;
  clearInterval(this.advert_timer);
};


Device.prototype.getCodeEvent = function(event_data, response) {
  //gets the app code and sends it in the response body
  //response: the HTTP response
  
  fs.readFile(app_code_path,'utf8',function(err,file) {
    if (!err) {
      response.writeHead(200, {'Content-Type': 'text/javascript'});
      response.end(file);
    } else {
      response.writeHead(404, {'Content-Type': 'text/plain'});
      response.end('cannot read file \n' + err);
    }
  });
};
Device.prototype.getHTMLEvent = function(event_data, response) {
  //gets the app code and sends it in the response body
  //response: the HTTP response
  
  fs.readFile(html_code_path,'utf8',function(err,file) {
    if (!err) {
      response.writeHead(200, {'Content-Type': 'text/html'});
      response.end(file);
    } else {
      response.writeHead(404, {'Content-Type': 'text/plain'});
      response.end('cannot read file \n' + err);
    }
  });
};

////////////////////IMPLEMENTATION SPECIFIC COMMANDS////////////////////////////
Device.prototype.startLogging = function(fields, resp) {
  "use strict";
  var this_dev = this;
  if(!this.logging_timer) {
    this.logging_timer = setInterval(function(){
      var options = {
        hostname: this_dev.manager_IP,
        port: this_dev.manager_port,
        path: "/?action=store&uuid="+this_dev.uuid,
        method: "POST"
      };
      var req = http.request(options, function(res){
        //TODO: check response in non-demo code
        //TODO: make sure post did not fail
      });
      req.on("error",function(e){
        console.log("whoops "+e);
      });
        var t = this_dev.getAveTemp();
	var oc = this_dev.getOccupy();
	var heater_info = led.status();
	var tempandoc =oc.toString()+","+t.toString()+','+heater_info.toString();
      req.end(tempandoc);
	console.log('logging temp: '+t+' heater ' +heater_info);
     //console.log('showing occupancy: '+tempandoc);
    },1000); //1seconds 
  }
  
  //TODO: make response reflect success or fail
  resp.writeHead(200, {'Content-Type': 'text/html'});
  resp.end();
};
Device.prototype.stopLogging = function(fields,resp){
  clearInterval(this.logging_timer);
    this.logging_timer = null;
  resp.writeHead(200, {'Content-Type': 'text/html'});
  resp.end();
};

Device.prototype.heaton = function(fileds,resp){
    //turn on heater
    var this_dev = this;
    led.turnOn();
    //led.pwm([0.9],[10])
    //exec('python onheat.py');
    console.log('heater on');
    resp.writeHead(200, {'Content-Type': 'text/html'});
    resp.end();
    this_dev.sendSMS('Heater in on', '2066737490');
};

Device.prototype.heatoff = function(fileds,resp){
    //turn off heater
    led.turnOff();
    //exec('python offheat.py');
    console.log('heater off');
    clearInterval(this.control_timer);
    this.control_timer = null;
       
    resp.writeHead(200, {'Content-Type': 'text/html'});
    resp.end();
};
Device.prototype.heatAutomatic = function(fileds,resp){
  //automatically heating using a naive control methods
  "use strict";
  var this_dev = this;
   // console.log('reach heatAutomatic function');
  if(!this.control_timer) {
    this.control_timer = setInterval(function(){
      var options = {
        hostname: this_dev.manager_IP,
        port: this_dev.manager_port,
        path: "/?action=store&uuid="+this_dev.uuid,
        method: "POST"
      };
	var current_temp = this_dev.getTemp();
	var oc = this_dev.getOccupy();
	var desired_temp = this_dev.tempset;
	console.log('heater receive tempset as ' +this_dev.tempset);
	if ((current_temp <desired_temp-3)){
           led.turnOn();
           console.log('heater control working');
	}
	else {
	    led.turnOff();
	    if (current_temp > desired_temp){
	    console.log('reach settings');
	    }
	    //if (oc==1){
//		console.log('heat block occupied');
//	    }
	    //else {
	//	console.log('something is wrong');
	  //  }
	};
     //console.log('showing occupancy: '+tempandoc);
    },1000); //10seconds //TODO: make this variable/not hard coded
  }
  
  //TODO: make response reflect success or fail
  resp.writeHead(200, {'Content-Type': 'text/html'});
  resp.end();
};

Device.prototype.heatpwm = function(fileds,resp){
  //automatically heat using pwm wave
  "use strict";
  var this_dev = this;
  var initial_temp;
    if (temp_rec ==1) {
    initial_temp = this_dev.getTemp();
	temp_rec = 0;
    }
   // console.log('reach heatAutomatic function');
  if(!this.control_timer) {
    this.control_timer = setInterval(function(){
      var options = {
        hostname: this_dev.manager_IP,
        port: this_dev.manager_port,
        path: "/?action=store&uuid="+this_dev.uuid,
        method: "POST"
      };
	var current_temp = this_dev.getTemp();
	var desired_temp = this_dev.tempset;
	console.log('heater receive tempset as ' +this_dev.tempset);
	var percent = (desired_temp - current_temp)/(desired_temp - initial_temp);
	if ( percent >= 1) {
	    percent = 1;
	}
	var pwm_percent = percent -0.15;
	if (pwm_percent <=0 ) {
	    pwm_percent = 0;
	}
	led.pwm ([pwm_percent],[10]);
	console.log('pwm working with ' + pwm_percent.toFixed(2).toString()+ ' '+ initial_temp.toFixed(2).toString());
	   
    },10000); //10seconds //TODO: make this variable/not hard coded
  }
  
    
        resp.writeHead(200, {'Content-Type': 'text/html'});
        resp.end();
};

Device.prototype.heatAutomaticEnd = function(fileds,resp){
    //End automatic heating  
    led.turnOff();
    console.log('End heating automatically, heater turned off');
    clearInterval(this.control_timer);
    this.control_timer = null;
    temp_rec = 1;
    resp.writeHead(200, {'Content-Type': 'text/html'});
    resp.end();
};

///////////////////////////////Data from UI input///////////////////////////////////
Device.prototype.desiredTemp = function(fields,response) {
  //parse the temperature settings heard from manager UI
  response.writeHead(200, {'Content-Type': 'text/plain'});
  response.end();
  this.tempset = parseInt(fields.tempset,10);
  console.log('receive tempset '+this.tempset);
   // this.manager_IP  = fields['@ip'] ;
 // clearInterval(this.advert_timer);
};
Device.prototype.cellphoneNumber = function(fields,response) {
  //parse the alert phone number info from manger and UI
  response.writeHead(200, {'Content-Type': 'text/plain'});
  response.end();
  this.cellphone = fields.cellphone;
  console.log('receive phone number ' + this.cellphone);
}
///////////////////////////////HELPER METHODS///////////////////////////////////
Device.prototype.getTemp = function() {
  //
  // Gets the temp from rpi.  Note this is blocking since the underlying
  // call to ioctl is blocking.
  // returns: the temp in deg C
  //
  var result = rSPI.readwriteSPI([96,0,0],'/dev/spidev0.1');
  var adcread = ((result[1]<<2) | (result[2]>>>6))*3.3/1024;
  var resistance = 3.3*10000/adcread - 10000;
  
  var a = 0.00113902;
  var b = 0.000232276;
  var c = 9.67879E-8;
  var lr = Math.log(resistance);
  var temp = -273.15+1/(a+b*lr+c*lr*lr*lr);
  
  return temp;  
};

Device.prototype.getAveTemp = function() {
  //
  // Gets the average temp from rpi through a 5 secs window average
  //
  var this_dev = this;
  var result = rSPI.readwriteSPI([96,0,0],'/dev/spidev0.1');
  var adcread = ((result[1]<<2) | (result[2]>>>6))*3.3/1024;
  var resistance = 3.3*10000/adcread - 10000;
  
  var a = 0.00113902;
  var b = 0.000232276;
  var c = 9.67879E-8;
  var lr = Math.log(resistance);
  var temp = -273.15+1/(a+b*lr+c*lr*lr*lr);
    temp_array.push(temp);
    if (temp_array.length >5){
	temp_array.shift();
    }

    return this_dev.getArrayAve(temp_array);  
};
Device.prototype.getArrayAve = function (dev_array){
    //
    //A function to calculate the average of a numerical array
    //
    var sum =0;
    var ave =0;
    for (var x=0; x < dev_array.length; x++)
    {
	sum = sum + dev_array[x];
	ave = sum/dev_array.length;
    }
    return ave;
};

Device.prototype.sendSMS = function (message, number){
  //
  // A function module that takes in message and phone number, sending a SMS with message   //content to the phone number using Google Voice.
  //
  client.sms({ to: number, text: message}, function(err, res, data){
	if(err){
	    return console.log(err);
	}
	console.log('SMS "' +text+ '" sent to', to[0] + '. Conversation id: ', data.send_sms_response.conversation_id);
    });

    return 0;

};

Device.prototype.getOccupy = function() {
  //
  // Gets the occupancy information of heat block from rpi.
  //
    this_dev = this;
    var result = rSPI.readwriteSPI([100,0,0],'/dev/spidev0.1');
    var adcread = ((result[1]<<2) | (result[2]>>>6))*5/1024;
    var resistance = 5*270000/adcread - 270000;//270k resistor, Ohm's law
    resist_array.push(resistance);
    if (resist_array.length >4){
	resist_array.shift();
    }
    //var sum_resist=0;
    //for (var x=0; x < resist_array.length; x++)
    //{
//	sum_resist = sum_resist + resist_array[x];
//	average_resist = sum_resist/resist_array.length;
  //  }
    var average_resist = this_dev.getArrayAve(resist_array); 
    var occupy = 0;
    console.log('resistance ='+((resistance/1000).toFixed(1)).toString()+' KOhms');
    if (average_resist > 800000)
    {
	occupy =0;
    }
    else if (average_resist <750000)
    { 
	occupy=1;
    }
    else {
	console.log('occupancy undecided');
    }
    return occupy;  
};

Device.prototype.sendAction = function(action,fields,callback) {
  //
  // sends action to manager.
  // action: string - the action to send to manager
  // fields: object - a hash of fields to send to in the request
  // callback: called when done takes responce data as argument
  //
  
  //TODO: response_data sholud probably be a buffer incase of binary data
  var response_data = '';
  fields.action = action;
  var options = {
    hostname: this.manager_IP,
    port: this.manager_port,
    path: url.format({query:fields, pathname:'/'}),
    method: "GET"
  };
  console.log(options.path);
  var actionReq = http.request(options,function(result){
    result.on('data', function(chunk){
      response_data += chunk;
    });
    result.on('end',function(){
      callback(response_data);
    });
  });
  actionReq.end();
};
Device.prototype.computeUUID = function(){
  //
  // Computes the Device's UUID from a combination of listen port and hostname
  //
  var unique_str = OS.hostname()+this.port;
  if (OS.type() === 'Linux'){
    //TODO: fill in for linux the MAC addr + listen_port
    //unique_str = mac addr + listen_port;
  } 
  //make uuid from unique string, roughly following uuid v5 spec 
  var hash = crypto.createHash('sha1').update(unique_str).digest('hex');
  return uuid = hash.substr(0,8)+"-"+hash.substr(8,4)+"-5"+hash.substr(12,3) +
              "-b"+hash.substr(15,3)+"-"+hash.substr(18,12);  
};

///////////////////////////////////// MAIN /////////////////////////////////////
//if i'm being called from command line
if(require.main === module) {
  var d1 = new Device(8432);
}

