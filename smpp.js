﻿var bitsyntax = require('ut-bitsyntax');
var nconf = require('nconf'); //todo remove nconf instead use _.assign and loading file with require
var _ = require('lodash');
var iconv = require('iconv-lite');
var tlvTagsByName = {
    'dest_addr_subunit': '0005',
    'dest_network_type': '0006',
    'dest_bearer_type': '0007',
    'dest_telematics_id': '0008',
    'source_addr_subunit': '000D',
    'source_network_type': '000E',
    'source_bearer_type': '000F',
    'source_telematics_id': '0010',
    'qos_time_to_live': '0017',
    'payload_type': '0019',
    'additional_status_info_text': '001D',
    'receipted_message_id': '001E',
    'ms_msg_wait_facilities': '0030',
    'privacy_indicator': '0201',
    'source_subaddress': '0202',
    'dest_subaddress': '0203',
    'user_message_reference': '0204',
    'user_response_code': '0205',
    'source_port': '020A',
    'dest_port': '020B',
    'sar_msg_ref_num': '020C',
    'language_indicator': '020D',
    'sar_total_segments': '020E',
    'sar_segment_seqnum': '020F',
    'sc_interface_version': '0210',
    'callback_num_pres_ind': '0302',
    'callback_num_atag': '0303',
    'number_of_messages': '0304',
    'callback_num': '0381',
    'dpf_result': '0420',
    'set_dpf': '0421',
    'ms_availability_status': '0422',
    'network_error_code': '0423',
    'message_payload': '0424',
    'delivery_failure_reason': '0425',
    'more_messages_to_send': '0426',
    'message_state': '0427',
    'congestion_state': '0428',
    'ussd_service_op': '0501',
    'broadcast_channel_indicator': '0600',
    'broadcast_content_type': '0601',
    'broadcast_content_type_info': '0602',
    'broadcast_message_class': '0603',
    'broadcast_rep_num': '0604',
    'broadcast_frequency_interval': '0605',
    'broadcast_area_identifier': '0606',
    'broadcast_error_status': '0607',
    'broadcast_area_success': '0608',
    'broadcast_end_time': '0609',
    'broadcast_service_group': '060A',
    'billing_identification': '060B',
    'source_network_id': '060D',
    'dest_network_id': '060E',
    'source_node_id': '060F',
    'dest_node_id': '0610',
    'dest_addr_np_resolution': '0611',
    'dest_addr_np_information': '0612',
    'dest_addr_np_country': '0613',
    'display_time': '1201',
    'sms_signal': '1203',
    'ms_validity': '1204',
    'alert_on_message_delivery': '130C',
    'its_reply_type': '1380',
    'its_session_info': '1383'
};
var tlvTagsById = _.invert(tlvTagsByName);

var encodingsByName = {
    'default'    : 3,
    'ISO-8859-1' : 3, // Latin 1
    'ISO-8859-5' : 6, // Cyrillic
    'ISO-8859-8' : 7, // Latin/Hebrew
    'utf16le'    : 8, // ISO/IEC-10646
    'UCS2'       : 8  // Alias of 'utf16le'
};

var encodingsById = _.invert(encodingsByName);
/**
 * SMPP commands parser
 *
 * @module SmppParser
 * @version 1.0
 */
function SmppParser(config, val, log) {
    this.logFactory = log;
    this.log = {};
    this.val = val;
    this.messageFormats = {};
    this.opCodes = {};
    this.headerPattern = bitsyntax.parse('commandId:32/integer, commandStatus:32/integer, sequenceNumber:32/integer, body/binary');
    this.tlvPattern = bitsyntax.parse('t:16/integer, l:16/integer, v:l/string, next/binary');
    this.init(config);
}

SmppParser.prototype.init = function(config) {
    this.logFactory && (this.log = this.logFactory.createLog(config.logLevel, {name:config.id, context:'SMPP codec'}));
    this.log.info && this.log.info('Initializing SMPP parser!');
    this.messageFormats = new nconf.Provider({
        stores: [
            {name: 'impl'   , type: 'literal', store: config.messageFormat},
            {name: 'default', type: 'file', file: require.resolve('./smpp.messages.json')}
        ]
    }).get();
    Object.keys(this.messageFormats).map(function(opcode) {
        if (this.messageFormats[opcode] && this.messageFormats[opcode].commandId) {
            if (this.messageFormats[opcode].pattern) {
                this.messageFormats[opcode].pattern = bitsyntax.parse(this.messageFormats[opcode].pattern.join(', '));
            }
            this.opCodes[this.messageFormats[opcode].commandId] = opcode;
        }
    }, this);
};

/**
 * Decoding Buffer
 * @param {Buffer} buff - buffer for decoding.
 * @returns {JSON}  json object with extracted values from buffer with property names from message pattern
 *  and system field $$:{'trace', 'mtid', 'opcode'}
 */
SmppParser.prototype.decode = function(buff, $meta) {
    this.log.debug && this.log.debug('SmppParser.decode buffer:' + buff.toString());
    var headObj = bitsyntax.match(this.headerPattern, buff);
    if (!headObj) {
        throw new Error('Unable to match header to header pattern!');
    }

    headObj.commandId = ('00000000' + headObj.commandId.toString(16).toUpperCase()).slice(-8);
    var opcode = this.opCodes[headObj.commandId];
    var messageFormat = this.messageFormats[opcode];
    var body = {};
    if (!opcode) {
        throw new Error('Not implemented opcode:' + headObj.commandId);
    }

    if (messageFormat.pattern) {
        if (headObj.body) {
            body = bitsyntax.match(messageFormat.pattern, headObj.body);
        }
        if (body.tlvs) {
            if (body.tlvs.length) {
                var tlvs = {};
                var tlv = bitsyntax.match(this.tlvPattern, body.tlvs);
                if (!tlv) {
                    throw new Error('Unable to match TLV!');
                }
                do {
                    if (!(tlv.t = tlvTagsById[('0000' + tlv.t.toString(16).toUpperCase()).slice(-4)])) {
                        throw new Error('Unknown TLV tag id: ' + tlv.t);
                    }
                    tlvs[tlv.t] = tlv.v;
                    tlv = bitsyntax.match(this.tlvPattern, tlv.next);
                } while (tlv);
                body.tlvs = tlvs;
            } else {
                body.tlvs = {};
            }
        }
    }
    // TODO: revise dataCoding and shortMessage
    if (body.dataCoding) {
        // maybe throw an error if dataCoding byte represents an integer which is an undefined index in the encodingsById object
        body.dataCoding = encodingsById[body.dataCoding] || encodingsById[encodingsByName['default']];
    }
    if (body.shortMessage) {
        body.shortMessage = iconv.decode(body.shortMessage, body.dataCoding || encodingsById[encodingsByName['default']]);
    }
    headObj.body = body;
    $meta = {trace: headObj.sequenceNumber, mtid : messageFormat.mtid, opcode : opcode};
    return headObj;
};

/**
 * Convert object to Buffer
 * @param {object} data - json object with fields:{$$:{opcode - required, trace - required},  rest are field names from message pattern}
 * @param {object} context - the connection context
 * @returns {buffer}  encoded buffer
 */
SmppParser.prototype.encode = function(data, $meta) {
    // TODO: add validation
    // TODO: revise dataCoding and shortMessage
    data.smLength = 0;
    if (data.dataCoding) {
        data.dataCoding = encodingsByName[data.dataCoding] || encodingsByName['default'];
    }

    if (data.shortMessage) {
        data.shortMessage = iconv.encode(data.shortMessage, encodingsById[data.dataCoding || encodingsByName['default']]);
        data.smLength = data.shortMessage.length;
    }
    this.log.debug && this.log.debug('SmppParser.encode data:' + data);
    var opcode = $meta.opcode;
    if (!this.messageFormats[opcode]) {
        throw new Error('Not implemented opcode:' + opcode + '!');
    }
    var sequenceNumber = $meta.context.trace;
    if (!sequenceNumber) {
        sequenceNumber = ('00000000' + $meta.context.trace).slice(-8);
        if (++$meta.context.trace > 999999) {
            $meta.context.trace = 0;
        }
    }

    var body = new Buffer('');
    if (this.messageFormats[opcode].pattern) {
        if (!data.tlvs || _.isEmpty(data.tlvs)) {
            data.tlvs = new Buffer(0); // pass empty buffer
        } else {
            if (!_.isObject(data.tlvs)) {
                throw new Error('data.tvls must be an object of tagName:value pairs');
            }
            var tlvs = '';
            var vBuffer = null;
            Object.keys(data.tlvs).map(function(tlv) {
                if (!tlvTagsByName[tlv]) {
                    throw new Error('Unknown TLV tag name: ' + tlv + '!');
                }
                vBuffer = new Buffer(data.tlvs[tlv]);
                tlvs += tlvTagsByName[tlv] + ('0000' + vBuffer.length.toString(16)).slice(-4) + vBuffer.toString('hex');
            }, this);
            data.tlvs = new Buffer(tlvs, 'hex');
        }
        body = bitsyntax.build(this.messageFormats[opcode].pattern, data);
        if (!body) {
            throw new Error('Unable to build body for opcode:' + opcode + '!');
        }
    }
    var commandId = this.messageFormats[opcode].commandId;
    var result = bitsyntax.build(this.headerPattern, {commandId: parseInt(commandId, 16), commandStatus: 0, sequenceNumber: sequenceNumber, body: body});
    return result;
};

module.exports = SmppParser;
