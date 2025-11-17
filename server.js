/**
 * server.js
 * WhatsApp Call Handler for Google Cloud Run
 *
 * - Parses incoming webhook shape matching your sample JSON.
 * - Auto-answers user-initiated calls by creating a WebRTC answer.
 * - Pushes continuous silent audio into the call (nonstandard.RTCAudioSource).
 *
 * ENV variables:
 *  VERIFY_TOKEN          - webhook verification token (string)
 *  META_ACCESS_TOKEN     - Graph API access token (string)
 *  META_API_VERSION      - e.g. v17.0 (default v23.0)
 *  META_BASE_URL         - default https://graph.facebook.com
 *  ANSWER_MODE           - "CALL_SCOPED" or "PHONE_SCOPED" (defaults to CALL_SCOPED)
 *
 * Notes:
 *  - The sendAnswer/sendIce functions include two common patterns (call-scoped vs phone-scoped).
 *    Confirm which one Meta requires from their docs or by testing. See README below.
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RTCPeerConnection, nonstandard } = require('wrtc');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'change_me';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_API_VERSION = process.env.META_API_VERSION || 'v17.0';
const META_BASE_URL = process.env.META_BASE_URL || 'https://graph.facebook.com';
const ANSWER_MODE = (process.env.ANSWER_MODE || 'CALL_SCOPED').toUpperCase(); // CALL_SCOPED | PHONE_SCOPED

if (!META_ACCESS_TOKEN) {
  console.warn('Warning: META_ACCESS_TOKEN is not set. Set it before running in production.');
}

// in-memory store for calls
const calls = new Map();

/* ---------- Webhook verification ---------- */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send('Forbidden - verify token mismatch');
    }
  }
  res.status(400).send('Bad Request');
});

/* ---------- Webhook event receiver ---------- */
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook payload (truncated):', JSON.stringify(body).slice(0, 800));

    // iterate entries -> changes -> value.calls[]
    const entry = body.entry || [];
    for (const ent of entry) {
      const changes = ent.changes || [];
      for (const change of changes) {
        const val = change.value || {};
        const phoneNumberId = val.metadata && val.metadata.phone_number_id;
        const callsArr = (val.calls && Array.isArray(val.calls)) ? val.calls : [];
        for (const call of callsArr) {
          // Example call object from you:
          // {
          //  "id":"wacid....",
          //  "from":"918103416377",
          //  "to":"917428487785",
          //  "event":"connect",
          //  "timestamp":"1763301256",
          //  "direction":"USER_INITIATED",
          //  "session": {"sdp":"v=0...","sdp_type":"offer"}
          // }
          const callId = call.id || call.call_id;
          const event = (call.event || '').toLowerCase();
          console.log('Call event:', event, 'callId:', callId);

          if (!callId) continue;

          if (event === 'connect' || event === 'offer' || event === 'call_offer') {
            // The sample uses session.sdp + sdp_type (offer)
            const sdp = (call.session && call.session.sdp) || (call.offer && call.offer.sdp) || call.sdp;
            const sdpType = call.session && call.session.sdp_type;
            if (sdp && sdpType && sdpType.toLowerCase().includes('offer')) {
              await handleCallOffer(callId, sdp, { phoneNumberId, call });
            } else if (sdp) {
              // fallback if sdp_type absent
              await handleCallOffer(callId, sdp, { phoneNumberId, call });
            } else {
              console.warn('Offer missing sdp for call', callId);
            }
          } else if (event === 'ice_candidate' || event === 'ice' || event === 'candidate') {
            // Some vendors use call.ice or call.candidate
            const candidateObj = call.ice || call.candidate || (call.ice && call.ice.candidate);
            if (candidateObj) {
              await handleRemoteIce(callId, candidateObj);
            } else {
              console.warn('ICE event missing candidate for', callId, call);
            }
          } else if (event === 'hangup' || event === 'disconnected' || event === 'end') {
            cleanupCall(callId);
          } else if (event === 'answered') {
            console.log('Call answered event for', callId);
          } else {
            console.log('Unhandled/unknown event:', event);
          }
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('Webhook POST error', err);
    res.status(500).send('Server error');
  }
});

/* ---------- Call handling ---------- */

async function handleCallOffer(callId, sdpOffer, ctx) {
  console.log(`handleCallOffer: ${callId} phoneNumberId=${ctx.phoneNumberId || 'unknown'}`);

  // If call exists, cleanup (re-negotiation)
  if (calls.has(callId)) {
    console.log('Existing call state found, cleaning up before re-creating', callId);
    cleanupCall(callId);
  }

  // Create PeerConnection
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // Local ICE buffer
  const localIceQueue = [];

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      console.log(`[${callId}] local ICE candidate generated`);
      localIceQueue.push(e.candidate);
      // send candidate to Meta immediately (best-effort)
      sendLocalIceToMeta(callId, ctx.phoneNumberId, e.candidate).catch(err => {
        console.error('sendLocalIceToMeta error', err && err.message ? err.message : err);
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[${callId}] pc connectionState:`, pc.connectionState);
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      cleanupCall(callId);
    }
  };

  // Create silent audio source and add track
  const audioSource = new nonstandard.RTCAudioSource();
  const track = audioSource.createTrack();
  pc.addTrack(track);

  // Set remote description (offer)
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
  } catch (err) {
    console.error('setRemoteDescription failed', err);
    cleanupIfExists(pc, track);
    return;
  }

  // Create answer
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // store call state
  calls.set(callId, {
    pc,
    audioSource,
    track,
    localIceQueue,
    phoneNumberId: ctx.phoneNumberId,
    createdAt: Date.now()
  });

  // start silent audio push
  const interval = startPushingSilentAudio(callId, audioSource);
  calls.get(callId).silentInterval = interval;

  // Send answer to Meta
  try {
    await sendAnswerToMeta(callId, ctx.phoneNumberId, answer.sdp);
    console.log('Posted answer to Meta for call', callId);
  } catch (err) {
    console.error('Failed to POST answer to Meta for call', callId, err && err.message ? err.message : err);
    cleanupCall(callId);
  }
}

function cleanupIfExists(pc, track) {
  try {
    if (track) track.stop();
    if (pc) pc.close();
  } catch (e) {}
}

async function handleRemoteIce(callId, candidateObj) {
  const state = calls.get(callId);
  if (!state) {
    console.warn('Received remote ICE for unknown call', callId);
    return;
  }
  try {
    // candidateObj might be a string or full object. Normalize for addIceCandidate.
    // Example from Meta may already be full candidate with candidate, sdpMid, sdpMLineIndex
    const cand = candidateObj.candidate ? candidateObj : { candidate: candidateObj };
    await state.pc.addIceCandidate(cand);
    console.log('Added remote ICE to pc for', callId);
  } catch (err) {
    console.error('Error addIceCandidate', err);
  }
}

function startPushingSilentAudio(callId, audioSource) {
  // 48kHz, 16-bit, mono. 20ms frames => 960 samples
  const sampleRate = 48000;
  const frameMs = 20;
  const samples = Math.floor(sampleRate * (frameMs / 1000));
  const silentFrame = new Int16Array(samples);

  const interval = setInterval(() => {
    try {
      audioSource.onData({
        samples: silentFrame,
        sampleRate,
        bitsPerSample: 16,
        channelCount: 1
      });
    } catch (err) {
      console.error('audioSource.onData error for', callId, err);
    }
  }, frameMs);

  return interval;
}

function cleanupCall(callId) {
  const s = calls.get(callId);
  if (!s) return;
  try {
    if (s.silentInterval) clearInterval(s.silentInterval);
    if (s.track) s.track.stop();
    if (s.pc) s.pc.close();
  } catch (e) {
    console.warn('Error during cleanup', e);
  }
  calls.delete(callId);
  console.log('Cleaned up call', callId);
}

/* ---------- Meta Graph calls: send answer & ICE ---------- */

/**
 * sendAnswerToMeta:
 * - Supports two common endpoint patterns:
 *   A) CALL_SCOPED: POST /{CALL_ID}/answer
 *   B) PHONE_SCOPED: POST /{PHONE_NUMBER_ID}/calls with body { type: 'answer', call_id: <callId>, sdp: <sdp> }
 *
 * Set ANSWER_MODE env to select behavior. Check Meta docs and set accordingly.
 */
async function sendAnswerToMeta(callId, phoneNumberId, answerSdp) {
  if (!META_ACCESS_TOKEN) {
    throw new Error('META_ACCESS_TOKEN missing');
  }

  if (ANSWER_MODE === 'PHONE_SCOPED') {
    // phone-scoped variant
    const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
    const body = {
      type: 'answer',
      call_id: callId,
      sdp: answerSdp
    };
    console.log('Sending PHONE_SCOPED answer to', url);
    const res = await axios.post(url, body, {
      params: { access_token: META_ACCESS_TOKEN },
      headers: { 'Content-Type': 'application/json' }
    });
    return res.data;
  } else {
    // call-scoped variant
    const url = `${META_BASE_URL}/${META_API_VERSION}/${callId}/answer`;
    const body = { sdp: answerSdp };
    console.log('Sending CALL_SCOPED answer to', url);
    const res = await axios.post(url, body, {
      params: { access_token: META_ACCESS_TOKEN },
      headers: { 'Content-Type': 'application/json' }
    });
    return res.data;
  }
}

/**
 * sendLocalIceToMeta:
 * Similar dual-mode support. Candidate payloads vary slightly per integration.
 */
async function sendLocalIceToMeta(callId, phoneNumberId, candidateObj) {
  if (!META_ACCESS_TOKEN) {
    console.warn('META_ACCESS_TOKEN missing, skipping sendLocalIceToMeta');
    return;
  }
  if (ANSWER_MODE === 'PHONE_SCOPED') {
    const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
    const body = {
      type: 'ice_candidate',
      call_id: callId,
      ice: {
        candidate: candidateObj.candidate,
        sdpMid: candidateObj.sdpMid,
        sdpMLineIndex: candidateObj.sdpMLineIndex
      }
    };
    try {
      await axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }});
    } catch (err) {
      console.error('phone-scoped sendLocalIceToMeta error', err && err.response ? err.response.data : err.message);
    }
  } else {
    const url = `${META_BASE_URL}/${META_API_VERSION}/${callId}/ice_candidates`;
    const body = {
      candidate: {
        candidate: candidateObj.candidate,
        sdpMid: candidateObj.sdpMid,
        sdpMLineIndex: candidateObj.sdpMLineIndex
      }
    };
    try {
      await axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }});
    } catch (err) {
      console.error('call-scoped sendLocalIceToMeta error', err && err.response ? err.response.data : err.message);
    }
  }
}

/* ---------- health ---------- */
app.get('/', (req, res) => res.send('WhatsApp Call Handler OK'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
