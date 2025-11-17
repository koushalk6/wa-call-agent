
/**
 * Production-ready WhatsApp Cloud API Calling (User-Initiated)
 * Node.js + WebRTC
 * Supports pre-accept + accept + ICE candidates + silent audio loop + pre-recorded TTS
 * Designed for deployment on Cloud Run / containerized environment
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const { RTCPeerConnection, nonstandard } = require('wrtc');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// --- Environment Variables ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'change_me';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_API_VERSION = process.env.META_API_VERSION || 'v17.0';
const META_BASE_URL = process.env.META_BASE_URL || 'https://graph.facebook.com';
const TURN_URL = process.env.TURN_URL;
const TURN_USER = process.env.TURN_USER;
const TURN_PASS = process.env.TURN_PASS;

if (!META_ACCESS_TOKEN) {
  console.error('META_ACCESS_TOKEN is required!');
  process.exit(1);
}

// --- In-memory call state ---
const calls = new Map();

// --- Webhook verification ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// --- Webhook POST receiver ---
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const entries = body.entry || [];

    for (const ent of entries) {
      const changes = ent.changes || [];
      for (const change of changes) {
        const val = change.value || {};
        const phoneNumberId = val.metadata?.phone_number_id;
        const callsArr = Array.isArray(val.calls) ? val.calls : [];

        for (const call of callsArr) {
          const callId = call.id || call.call_id;
          const event = (call.event || '').toLowerCase();
          if (!callId) continue;

          if (['offer', 'call_offer', 'connect'].includes(event)) {
            const sdp = call.session?.sdp || call.sdp;
            if (sdp) await handleCallOffer(callId, sdp, phoneNumberId);
          } else if (['ice_candidate', 'ice', 'candidate'].includes(event)) {
            const candidateObj = call.ice || call.candidate;
            if (candidateObj) await handleRemoteIce(callId, candidateObj);
          } else if (['hangup', 'disconnected', 'end', 'terminate'].includes(event)) {
            console.log(`Call ended: ${callId}`);
            cleanupCall(callId);
          } else {
            console.log(`Unhandled event: ${event}`);
          }
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Server error');
  }
});

// --- Call Handling ---
async function handleCallOffer(callId, sdpOffer, phoneNumberId) {
  console.log(`Handling offer for call ${callId}`);

  if (calls.has(callId)) cleanupCall(callId);

  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_URL && TURN_USER && TURN_PASS) {
    iceServers.push({ urls: TURN_URL, username: TURN_USER, credential: TURN_PASS });
  }

  const pc = new RTCPeerConnection({ iceServers });

  // Add silent audio track
  const audioSource = new nonstandard.RTCAudioSource();
  const track = audioSource.createTrack();
  pc.addTrack(track);

  // Fetch and convert TTS to PCM
  await fetchAndConvertTTS('Welcome to Avasar, the citizen-driven platform. Earn money by completing brand tasks.');

  // Mix TTS PCM into silent audio
  const ttsBuffer = fs.readFileSync('greeting.pcm');
  const ttsFrameSize = 960; // 20ms frames at 48kHz
  let ttsOffset = 0;

  const localIce = [];
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      localIce.push(e.candidate);
      sendLocalIceToMeta(callId, phoneNumberId, e.candidate).catch(console.error);
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) cleanupCall(callId);
  };

  await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') resolve();
    else pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') resolve();
    };
  });

  await preAcceptCall(callId, phoneNumberId, pc.localDescription.sdp);
  await acceptCall(callId, phoneNumberId, pc.localDescription.sdp);

  const interval = setInterval(() => {
    try {
      const frame = new Int16Array(960);
      // Mix TTS
      for (let i = 0; i < 960 && ttsOffset < ttsBuffer.length / 2; i++, ttsOffset++) {
        const sample = ttsBuffer.readInt16LE(ttsOffset * 2);
        frame[i] = sample;
      }
      audioSource.onData({ samples: frame, sampleRate: 48000, bitsPerSample: 16, channelCount: 1 });
    } catch (err) {
      console.error(`Audio frame error for ${callId}`, err);
    }
  }, 20);

  calls.set(callId, { pc, audioSource, track, interval });
  console.log(`✅ Call ${callId} setup complete`);
}

// --- Fetch Google TTS + Convert to PCM ---
async function fetchAndConvertTTS(text) {
  const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;
  const response = await axios.get(ttsUrl, { responseType: 'arraybuffer' });
  fs.writeFileSync('greeting.mp3', response.data);

  await new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i greeting.mp3 -ar 48000 -ac 1 -c:a pcm_s16le greeting.pcm`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// --- Handle remote ICE candidate ---
async function handleRemoteIce(callId, candidateObj) {
  const callState = calls.get(callId);
  if (!callState) return console.warn(`ICE received for unknown call ${callId}`);
  let cand = candidateObj;
  if (typeof candidateObj === 'string') cand = { candidate: candidateObj };
  try { await callState.pc.addIceCandidate(cand); }
  catch (err) { console.error(`Error adding ICE for ${callId}:`, err); }
}

// --- Cleanup ---
function cleanupCall(callId) {
  const st = calls.get(callId);
  if (!st) return;
  try {
    if (st.track) st.track.stop();
    if (st.pc) st.pc.close();
    if (st.interval) clearInterval(st.interval);
  } catch (err) { console.warn('Cleanup error:', err); }
  calls.delete(callId);
  console.log(`Call cleaned up: ${callId}`);
}

// --- WhatsApp Cloud API: Pre-Accept & Accept ---
async function preAcceptCall(callId, phoneNumberId, answerSdp) {
  const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
  const body = { messaging_product: "whatsapp", call_id: callId, action: "pre_accept", session: { sdp_type: "answer", sdp: answerSdp } };
  await axios.post(url, body, { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
  console.log(`✅ Call pre-accepted: ${callId}`);
}

async function acceptCall(callId, phoneNumberId, answerSdp) {
  const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
  const body = { messaging_product: "whatsapp", call_id: callId, action: "accept", session: { sdp_type: "answer", sdp: answerSdp } };
  await axios.post(url, body, { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
  console.log(`✅ Call accepted: ${callId}`);
}

// --- Send local ICE to Meta ---
async function sendLocalIceToMeta(callId, phoneNumberId, candidateObj) {
  const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
  const body = { messaging_product: "whatsapp", call_id: callId, type: "ice_candidate", ice: { candidate: candidateObj.candidate, sdpMid: candidateObj.sdpMid, sdpMLineIndex: candidateObj.sdpMLineIndex } };
  await axios.post(url, body, { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

// --- Health Check ---
app.get('/', (_, res) => res.send('WhatsApp Cloud API Call Handler OK'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));















// /**
//  * Production-ready WhatsApp Cloud API Calling (User-Initiated)
//  * Node.js + WebRTC
//  * Supports pre-accept + accept + ICE candidates + silent audio loop
//  * Designed for deployment on Cloud Run / containerized environment
//  */

// const express = require('express');
// const bodyParser = require('body-parser');
// const axios = require('axios');
// const { RTCPeerConnection, nonstandard } = require('wrtc');

// const app = express();
// app.use(bodyParser.json({ limit: '10mb' }));

// // --- Environment Variables ---
// const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'change_me';
// const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
// const META_API_VERSION = process.env.META_API_VERSION || 'v17.0';
// const META_BASE_URL = process.env.META_BASE_URL || 'https://graph.facebook.com';
// const TURN_URL = process.env.TURN_URL;
// const TURN_USER = process.env.TURN_USER;
// const TURN_PASS = process.env.TURN_PASS;

// if (!META_ACCESS_TOKEN) {
//   console.error('META_ACCESS_TOKEN is required!');
//   process.exit(1);
// }

// // --- In-memory call state ---
// const calls = new Map();

// // --- Webhook verification ---
// app.get('/webhook', (req, res) => {
//   const mode = req.query['hub.mode'];
//   const token = req.query['hub.verify_token'];
//   const challenge = req.query['hub.challenge'];

//   if (mode === 'subscribe' && token === VERIFY_TOKEN) {
//     console.log('✅ Webhook verified');
//     return res.status(200).send(challenge);
//   }
//   res.status(403).send('Forbidden');
// });

// // --- Webhook POST receiver ---
// app.post('/webhook', async (req, res) => {
//   try {
//     const body = req.body;
//     const entries = body.entry || [];

//     for (const ent of entries) {
//       const changes = ent.changes || [];
//       for (const change of changes) {
//         const val = change.value || {};
//         const phoneNumberId = val.metadata?.phone_number_id;
//         const callsArr = Array.isArray(val.calls) ? val.calls : [];

//         for (const call of callsArr) {
//           const callId = call.id || call.call_id;
//           const event = (call.event || '').toLowerCase();

//           if (!callId) continue;

//           if (['offer', 'call_offer', 'connect'].includes(event)) {
//             const sdp = call.session?.sdp || call.sdp;
//             if (sdp) await handleCallOffer(callId, sdp, phoneNumberId);
//           } else if (['ice_candidate', 'ice', 'candidate'].includes(event)) {
//             const candidateObj = call.ice || call.candidate;
//             if (candidateObj) await handleRemoteIce(callId, candidateObj);
//           } else if (['hangup', 'disconnected', 'end', 'terminate'].includes(event)) {
//             console.log(`Call ended: ${callId}`);
//             cleanupCall(callId);
//           } else {
//             console.log(`Unhandled event: ${event}`);
//           }
//         }
//       }
//     }
//     res.status(200).send('EVENT_RECEIVED');
//   } catch (err) {
//     console.error('Webhook handler error:', err);
//     res.status(500).send('Server error');
//   }
// });

// // --- Call Handling ---
// async function handleCallOffer(callId, sdpOffer, phoneNumberId) {
//   console.log(`Handling offer for call ${callId}`);

//   if (calls.has(callId)) cleanupCall(callId);

//   const iceServers = [
//     { urls: 'stun:stun.l.google.com:19302' },
//   ];
//   if (TURN_URL && TURN_USER && TURN_PASS) {
//     iceServers.push({ urls: TURN_URL, username: TURN_USER, credential: TURN_PASS });
//   }

//   const pc = new RTCPeerConnection({ iceServers });

//   // Add silent audio track
//   const audioSource = new nonstandard.RTCAudioSource();
//   const track = audioSource.createTrack();
//   pc.addTrack(track);

//   const localIce = [];
//   pc.onicecandidate = (e) => {
//     if (e.candidate) {
//       localIce.push(e.candidate);
//       sendLocalIceToMeta(callId, phoneNumberId, e.candidate).catch(console.error);
//     }
//   };

//   pc.onconnectionstatechange = () => {
//     if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) cleanupCall(callId);
//   };

//   await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
//   const answer = await pc.createAnswer();
//   await pc.setLocalDescription(answer);

//   // Wait for ICE gathering to complete
//   await new Promise(resolve => {
//     if (pc.iceGatheringState === 'complete') resolve();
//     else pc.onicegatheringstatechange = () => {
//       if (pc.iceGatheringState === 'complete') resolve();
//     };
//   });

//   // Pre-accept the call
//   await preAcceptCall(callId, phoneNumberId, pc.localDescription.sdp);

//   // Accept the call
//   await acceptCall(callId, phoneNumberId, pc.localDescription.sdp);

//   // Start silent audio loop after accept
//   const interval = startSilentAudioLoop(callId, audioSource);
//   calls.set(callId, { pc, audioSource, track, interval });

//   console.log(`✅ Call ${callId} setup complete`);
// }

// // --- Handle remote ICE candidate ---
// async function handleRemoteIce(callId, candidateObj) {
//   const callState = calls.get(callId);
//   if (!callState) return console.warn(`ICE received for unknown call ${callId}`);

//   let cand = candidateObj;
//   if (typeof candidateObj === 'string') cand = { candidate: candidateObj };

//   try {
//     await callState.pc.addIceCandidate(cand);
//   } catch (err) {
//     console.error(`Error adding ICE for ${callId}:`, err);
//   }
// }

// // --- Cleanup ---
// function cleanupCall(callId) {
//   const st = calls.get(callId);
//   if (!st) return;

//   try {
//     if (st.track) st.track.stop();
//     if (st.pc) st.pc.close();
//     if (st.interval) clearInterval(st.interval);
//   } catch (err) {
//     console.warn('Cleanup error:', err);
//   }

//   calls.delete(callId);
//   console.log(`Call cleaned up: ${callId}`);
// }

// // --- Silent Audio Loop ---
// function startSilentAudioLoop(callId, audioSource) {
//   const sampleRate = 48000;
//   const frameMs = 20;
//   const samples = Math.floor(sampleRate * frameMs / 1000); // 960 samples
//   const silentFrame = new Int16Array(samples);

//   const interval = setInterval(() => {
//     try {
//       audioSource.onData({
//         samples: silentFrame,
//         sampleRate,
//         bitsPerSample: 16,
//         channelCount: 1
//       });
//     } catch (err) {
//       console.error(`Audio frame error for ${callId}`, err);
//     }
//   }, frameMs);

//   return interval;
// }

// // --- WhatsApp Cloud API: Pre-Accept & Accept ---
// async function preAcceptCall(callId, phoneNumberId, answerSdp) {
//   const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
//   const body = {
//     messaging_product: "whatsapp",
//     call_id: callId,
//     action: "pre_accept",
//     session: { sdp_type: "answer", sdp: answerSdp }
//   };

//   await axios.post(url, body, {
//     headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
//   });

//   console.log(`✅ Call pre-accepted: ${callId}`);
// }

// async function acceptCall(callId, phoneNumberId, answerSdp) {
//   const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
//   const body = {
//     messaging_product: "whatsapp",
//     call_id: callId,
//     action: "accept",
//     session: { sdp_type: "answer", sdp: answerSdp }
//   };

//   await axios.post(url, body, {
//     headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
//   });

//   console.log(`✅ Call accepted: ${callId}`);
// }

// // --- Send local ICE to Meta ---
// async function sendLocalIceToMeta(callId, phoneNumberId, candidateObj) {
//   const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
//   const body = {
//     messaging_product: "whatsapp",
//     call_id: callId,
//     type: "ice_candidate",
//     ice: {
//       candidate: candidateObj.candidate,
//       sdpMid: candidateObj.sdpMid,
//       sdpMLineIndex: candidateObj.sdpMLineIndex
//     }
//   };

//   await axios.post(url, body, {
//     headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
//   });
// }

// // --- Health Check ---
// app.get('/', (_, res) => res.send('WhatsApp Cloud API Call Handler OK'));

// const PORT = process.env.PORT || 8080;
// app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));






















// // /**
// //  * Production-ready WhatsApp Cloud API Calling (User-Initiated)
// //  * Node.js + WebRTC
// //  * Designed for deployment on Cloud Run / containerized environment
// //  */

// // const express = require('express');
// // const bodyParser = require('body-parser');
// // const axios = require('axios');
// // const { RTCPeerConnection, nonstandard } = require('wrtc');
// // const app = express();

// // app.use(bodyParser.json({ limit: '10mb' }));

// // // --- Environment Variables ---
// // const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'change_me';
// // const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
// // const META_API_VERSION = process.env.META_API_VERSION || 'v17.0';
// // const META_BASE_URL = process.env.META_BASE_URL || 'https://graph.facebook.com';
// // const TURN_URL = process.env.TURN_URL; // e.g., turn:your.turn.server:3478
// // const TURN_USER = process.env.TURN_USER;
// // const TURN_PASS = process.env.TURN_PASS;
// // const ANSWER_MODE = (process.env.ANSWER_MODE || 'CALL_SCOPED').toUpperCase();

// // if (!META_ACCESS_TOKEN) {
// //   console.error('META_ACCESS_TOKEN is required!');
// //   process.exit(1);
// // }

// // // In-memory call state
// // const calls = new Map();

// // // --- Webhook verification ---
// // app.get('/webhook', (req, res) => {
// //   const mode = req.query['hub.mode'];
// //   const token = req.query['hub.verify_token'];
// //   const challenge = req.query['hub.challenge'];

// //   if (mode === 'subscribe' && token === VERIFY_TOKEN) {
// //     console.log('✅ Webhook verified');
// //     return res.status(200).send(challenge);
// //   }
// //   res.status(403).send('Forbidden');
// // });

// // // --- Webhook POST receiver ---
// // app.post('/webhook', async (req, res) => {
// //   try {
// //     const body = req.body;
// //     const entries = body.entry || [];

// //     for (const ent of entries) {
// //       const changes = ent.changes || [];
// //       for (const change of changes) {
// //         const val = change.value || {};
// //         const phoneNumberId = val.metadata?.phone_number_id;
// //         const callsArr = Array.isArray(val.calls) ? val.calls : [];

// //         for (const call of callsArr) {
// //           const callId = call.id || call.call_id;
// //           const event = (call.event || '').toLowerCase();

// //           if (!callId) continue;

// //           if (['offer', 'call_offer', 'connect'].includes(event)) {
// //             const sdp = call.session?.sdp || call.sdp;
// //             if (sdp) await handleCallOffer(callId, sdp, phoneNumberId);
// //           } else if (['ice_candidate', 'ice', 'candidate'].includes(event)) {
// //             const candidateObj = call.ice || call.candidate;
// //             if (candidateObj) await handleRemoteIce(callId, candidateObj);
// //           } else if (['hangup', 'disconnected', 'end', 'terminate'].includes(event)) {
// //             console.log(`Call ended: ${callId}`);
// //             cleanupCall(callId);
// //           } else {
// //             console.log(`Unhandled event: ${event}`);
// //           }
// //         }
// //       }
// //     }
// //     res.status(200).send('EVENT_RECEIVED');
// //   } catch (err) {
// //     console.error('Webhook handler error:', err);
// //     res.status(500).send('Server error');
// //   }
// // });

// // // --- Call Handling ---
// // async function handleCallOffer(callId, sdpOffer, phoneNumberId) {
// //   console.log(`Handling offer for call ${callId}`);

// //   if (calls.has(callId)) cleanupCall(callId);

// //   const iceServers = [
// //     { urls: 'stun:stun.l.google.com:19302' },
// //   ];

// //   if (TURN_URL && TURN_USER && TURN_PASS) {
// //     iceServers.push({ urls: TURN_URL, username: TURN_USER, credential: TURN_PASS });
// //   }

// //   const pc = new RTCPeerConnection({ iceServers });

// //   const audioSource = new nonstandard.RTCAudioSource();
// //   const track = audioSource.createTrack();
// //   pc.addTrack(track);

// //   const localIce = [];
// //   pc.onicecandidate = (e) => {
// //     if (e.candidate) {
// //       localIce.push(e.candidate);
// //       sendLocalIceToMeta(callId, phoneNumberId, e.candidate).catch(console.error);
// //     }
// //   };

// //   pc.onconnectionstatechange = () => {
// //     if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) cleanupCall(callId);
// //   };

// //   await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });

// //   const answer = await pc.createAnswer();
// //   await pc.setLocalDescription(answer);

// //   await new Promise(resolve => {
// //     if (pc.iceGatheringState === 'complete') resolve();
// //     else pc.onicegatheringstatechange = () => {
// //       if (pc.iceGatheringState === 'complete') resolve();
// //     };
// //   });

// //   const interval = startSilentAudioLoop(callId, audioSource);
// //   calls.set(callId, { pc, audioSource, track, interval });

// //   try {
// //     await sendAnswerToMeta(callId, phoneNumberId, pc.localDescription.sdp);
// //     console.log(`✅ Answer sent for call ${callId}`);
// //   } catch (err) {
// //     console.error('Failed to send answer:', err);
// //     cleanupCall(callId);
// //   }
// // }

// // async function handleRemoteIce(callId, candidateObj) {
// //   const callState = calls.get(callId);
// //   if (!callState) return console.warn(`ICE received for unknown call ${callId}`);

// //   let cand = candidateObj;
// //   if (typeof candidateObj === 'string') cand = { candidate: candidateObj };

// //   try { await callState.pc.addIceCandidate(cand); }
// //   catch (err) { console.error(`Error adding ICE for ${callId}:`, err); }
// // }

// // function cleanupCall(callId) {
// //   const st = calls.get(callId);
// //   if (!st) return;

// //   try {
// //     if (st.track) st.track.stop();
// //     if (st.pc) st.pc.close();
// //     if (st.interval) clearInterval(st.interval);
// //   } catch (err) { console.warn('Cleanup error:', err); }

// //   calls.delete(callId);
// //   console.log(`Call cleaned up: ${callId}`);
// // }

// // // --- Silent Audio Loop ---
// // // function startSilentAudioLoop(callId, audioSource) {
// // //   const sampleRate = 48000;
// // //   const frameMs = 20;
// // //   const samples = Math.floor(sampleRate * frameMs / 1000);
// // //   const silentFrame = new Int16Array(samples);

// // //   const interval = setInterval(() => {
// // //     try {
// // //       audioSource.onData({ samples: silentFrame, sampleRate, bitsPerSample: 16, channelCount: 1 });
// // //     } catch (err) { console.error(`Audio frame error for ${callId}`, err); }
// // //   }, frameMs);

// // //   return interval;
// // // }


// // function startSilentAudioLoop(callId, audioSource) {
// //   const sampleRate = 48000;
// //   const frameMs = 20;
// //   const samples = Math.floor(sampleRate * frameMs / 1000); // 960 samples
// //   const silentFrame = new Int16Array(samples); // 960 elements

// //   const interval = setInterval(() => {
// //     try {
// //       audioSource.onData({
// //         samples: silentFrame,
// //         sampleRate: sampleRate,
// //         bitsPerSample: 16,
// //         channelCount: 1
// //       });
// //     } catch (err) {
// //       console.error(`Audio frame error for ${callId}`, err);
// //     }
// //   }, frameMs);

// //   return interval;
// // }
// // //==============================================

// // // --- Meta Graph API calls ---
// // async function sendAnswerToMeta(callId, phoneNumberId, answerSdp) {
// //   const url = ANSWER_MODE === 'PHONE_SCOPED'
// //     ? `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`
// //     : `${META_BASE_URL}/${META_API_VERSION}/${callId}/answer`;

// //   const body = ANSWER_MODE === 'PHONE_SCOPED'
// //     ? { type: 'answer', call_id: callId, sdp: answerSdp }
// //     : { sdp: answerSdp };

// //   await axios.post(url, body, {
// //     params: { access_token: META_ACCESS_TOKEN },
// //     headers: { 'Content-Type': 'application/json' },
// //   });
// // }

// // async function sendLocalIceToMeta(callId, phoneNumberId, candidateObj) {
// //   if (ANSWER_MODE !== 'PHONE_SCOPED') return;

// //   const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
// //   const body = {
// //     type: 'ice_candidate',
// //     call_id: callId,
// //     ice: {
// //       candidate: candidateObj.candidate,
// //       sdpMid: candidateObj.sdpMid,
// //       sdpMLineIndex: candidateObj.sdpMLineIndex
// //     }
// //   };

// //   await axios.post(url, body, {
// //     params: { access_token: META_ACCESS_TOKEN },
// //     headers: { 'Content-Type': 'application/json' },
// //   });
// // }

// // // --- Health Check ---
// // app.get('/', (_, res) => res.send('WhatsApp Cloud API Call Handler OK'));

// // const PORT = process.env.PORT || 8080;
// // app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));





















// // /**
// // //  * server.js
// // //  * WhatsApp Call Handler for Google Cloud Run
// // //  *
// // //  * - Parses incoming webhook shape matching your sample JSON.
// // //  * - Auto-answers user-initiated calls by creating a WebRTC answer.
// // //  * - Pushes continuous silent audio into the call (nonstandard.RTCAudioSource).
// // //  *
// // //  * ENV variables:
// // //  *  VERIFY_TOKEN          - webhook verification token (string)
// // //  *  META_ACCESS_TOKEN     - Graph API access token (string)
// // //  *  META_API_VERSION      - e.g. v17.0 (default v23.0)
// // //  *  META_BASE_URL         - default https://graph.facebook.com
// // //  *  ANSWER_MODE           - "CALL_SCOPED" or "PHONE_SCOPED" (defaults to CALL_SCOPED)
// // //  */

// // // const express = require('express');
// // // const bodyParser = require('body-parser');
// // // const axios = require('axios');
// // // const { RTCPeerConnection, nonstandard } = require('wrtc');
// // // const { v4: uuidv4 } = require('uuid');

// // // const app = express();
// // // app.use(bodyParser.json({ limit: '10mb' }));

// // // const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'change_me';
// // // const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
// // // const META_API_VERSION = process.env.META_API_VERSION || 'v17.0';
// // // const META_BASE_URL = process.env.META_BASE_URL || 'https://graph.facebook.com';
// // // const ANSWER_MODE = (process.env.ANSWER_MODE || 'CALL_SCOPED').toUpperCase(); // CALL_SCOPED | PHONE_SCOPED

// // // if (!META_ACCESS_TOKEN) {
// // //   console.warn('Warning: META_ACCESS_TOKEN is not set. Set it before running in production.');
// // // }

// // // // In-memory store for calls
// // // const calls = new Map();

// // // /* ---------- Webhook verification ---------- */
// // // app.get('/webhook', (req, res) => {
// // //   const mode = req.query['hub.mode'];
// // //   const token = req.query['hub.verify_token'];
// // //   const challenge = req.query['hub.challenge'];
// // //   if (mode && token) {
// // //     if (mode === 'subscribe' && token === VERIFY_TOKEN) {
// // //       console.log('Webhook verified');
// // //       return res.status(200).send(challenge);
// // //     } else {
// // //       return res.status(403).send('Forbidden - verify token mismatch');
// // //     }
// // //   }
// // //   res.status(400).send('Bad Request');
// // // });

// // // /* ---------- Webhook event receiver ---------- */
// // // app.post('/webhook', async (req, res) => {
// // //   try {
// // //     const body = req.body;
// // //     console.log('Webhook payload (truncated):', JSON.stringify(body).slice(0, 800));

// // //     const entry = body.entry || [];
// // //     for (const ent of entry) {
// // //       const changes = ent.changes || [];
// // //       for (const change of changes) {
// // //         const val = change.value || {};
// // //         const phoneNumberId = val.metadata && val.metadata.phone_number_id;
// // //         const callsArr = (val.calls && Array.isArray(val.calls)) ? val.calls : [];
// // //         for (const call of callsArr) {
// // //           const callId = call.id || call.call_id;
// // //           const event = (call.event || '').toLowerCase();
// // //           console.log('Call event:', event, 'callId:', callId);

// // //           if (!callId) continue;

// // //           if (['connect', 'offer', 'call_offer'].includes(event)) {
// // //             const sdp = (call.session && call.session.sdp) || (call.offer && call.offer.sdp) || call.sdp;
// // //             const sdpType = call.session && call.session.sdp_type;
// // //             if (sdp) {
// // //               await handleCallOffer(callId, sdp, { phoneNumberId, call });
// // //             } else {
// // //               console.warn('Offer missing sdp for call', callId);
// // //             }
// // //           } else if (['ice_candidate', 'ice', 'candidate'].includes(event)) {
// // //             const candidateObj = call.ice || call.candidate || (call.ice && call.ice.candidate);
// // //             if (candidateObj) {
// // //               await handleRemoteIce(callId, candidateObj);
// // //             } else {
// // //               console.warn('ICE event missing candidate for', callId, call);
// // //             }
// // //           } else if (['hangup', 'disconnected', 'end'].includes(event)) {
// // //             cleanupCall(callId);
// // //           } else if (event === 'answered') {
// // //             console.log('Call answered event for', callId);
// // //           } else {
// // //             console.log('Unhandled/unknown event:', event);
// // //           }
// // //         }
// // //       }
// // //     }

// // //     res.status(200).send('EVENT_RECEIVED');
// // //   } catch (err) {
// // //     console.error('Webhook POST error', err);
// // //     res.status(500).send('Server error');
// // //   }
// // // });

// // // /* ---------- Call handling ---------- */
// // // async function handleCallOffer(callId, sdpOffer, ctx) {
// // //   console.log(`handleCallOffer: ${callId} phoneNumberId=${ctx.phoneNumberId || 'unknown'}`);

// // //   if (calls.has(callId)) {
// // //     console.log('Existing call state found, cleaning up before re-creating', callId);
// // //     cleanupCall(callId);
// // //   }

// // //   const pc = new RTCPeerConnection({
// // //     iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
// // //   });

// // //   const audioSource = new nonstandard.RTCAudioSource();
// // //   const track = audioSource.createTrack();
// // //   pc.addTrack(track);

// // //   const iceCandidates = [];
// // //   pc.onicecandidate = (e) => {
// // //     if (e.candidate) {
// // //       iceCandidates.push(e.candidate);
// // //       sendLocalIceToMeta(callId, ctx.phoneNumberId, e.candidate).catch(err => {
// // //         console.error('sendLocalIceToMeta error', err && err.message ? err.message : err);
// // //       });
// // //     }
// // //   };

// // //   pc.onconnectionstatechange = () => {
// // //     if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
// // //       cleanupCall(callId);
// // //     }
// // //   };

// // //   await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
// // //   const answer = await pc.createAnswer();
// // //   await pc.setLocalDescription(answer);

// // //   // Wait for ICE gathering complete
// // //   await new Promise(resolve => {
// // //     if (pc.iceGatheringState === 'complete') return resolve();
// // //     pc.onicegatheringstatechange = () => {
// // //       if (pc.iceGatheringState === 'complete') resolve();
// // //     };
// // //   });

// // //   calls.set(callId, { pc, audioSource, track, phoneNumberId: ctx.phoneNumberId });

// // //   // Start pushing silent audio
// // //   const interval = startPushingSilentAudio(callId, audioSource);
// // //   calls.get(callId).silentInterval = interval;

// // //   try {
// // //     await sendAnswerToMeta(callId, ctx.phoneNumberId, pc.localDescription.sdp);
// // //     console.log('Answer sent to Meta for call', callId);
// // //   } catch (err) {
// // //     console.error('Failed to send answer to Meta', err?.message || err);
// // //     cleanupCall(callId);
// // //   }
// // // }

// // // async function handleRemoteIce(callId, candidateObj) {
// // //   const state = calls.get(callId);
// // //   if (!state) {
// // //     console.warn('Remote ICE for unknown call', callId);
// // //     return;
// // //   }
// // //   try {
// // //     const cand = candidateObj.candidate ? candidateObj : { candidate: candidateObj };
// // //     await state.pc.addIceCandidate(cand);
// // //     console.log('Remote ICE added for', callId);
// // //   } catch (err) {
// // //     console.error('addIceCandidate error', err);
// // //   }
// // // }

// // // function startPushingSilentAudio(callId, audioSource) {
// // //   const sampleRate = 48000;
// // //   const frameMs = 20; // 20ms frames = 960 samples
// // //   const samples = Math.floor(sampleRate * (frameMs / 1000));
// // //   const silentFrame = new Int16Array(samples);

// // //   const interval = setInterval(() => {
// // //     try {
// // //       audioSource.onData({
// // //         samples: silentFrame,
// // //         sampleRate,
// // //         bitsPerSample: 16,
// // //         channelCount: 1
// // //       });
// // //     } catch (err) {
// // //       console.error('audioSource.onData error for', callId, err);
// // //     }
// // //   }, frameMs);

// // //   return interval;
// // // }

// // // function cleanupCall(callId) {
// // //   const s = calls.get(callId);
// // //   if (!s) return;
// // //   try {
// // //     if (s.silentInterval) clearInterval(s.silentInterval);
// // //     if (s.track) s.track.stop();
// // //     if (s.pc) s.pc.close();
// // //   } catch (e) {
// // //     console.warn('Error during cleanup', e);
// // //   }
// // //   calls.delete(callId);
// // //   console.log('Cleaned up call', callId);
// // // }

// // // async function sendAnswerToMeta(callId, phoneNumberId, answerSdp) {
// // //   if (!META_ACCESS_TOKEN) throw new Error('META_ACCESS_TOKEN missing');

// // //   if (ANSWER_MODE === 'PHONE_SCOPED') {
// // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
// // //     const body = { type: 'answer', call_id: callId, sdp: answerSdp };
// // //     return axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }, headers: { 'Content-Type': 'application/json' }});
// // //   } else {
// // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${callId}/answer`;
// // //     const body = { sdp: answerSdp };
// // //     return axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }, headers: { 'Content-Type': 'application/json' }});
// // //   }
// // // }

// // // async function sendLocalIceToMeta(callId, phoneNumberId, candidateObj) {
// // //   if (!META_ACCESS_TOKEN) return;
// // //   if (ANSWER_MODE === 'PHONE_SCOPED') {
// // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
// // //     const body = { type: 'ice_candidate', call_id: callId, ice: candidateObj };
// // //     try { await axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }}); } 
// // //     catch (err) { console.error('phone-scoped sendLocalIceToMeta error', err?.response?.data || err.message); }
// // //   } else {
// // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${callId}/ice_candidates`;
// // //     const body = { candidate: candidateObj };
// // //     try { await axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }}); } 
// // //     catch (err) { console.error('call-scoped sendLocalIceToMeta error', err?.response?.data || err.message); }
// // //   }
// // // }

// // // /* ---------- health ---------- */
// // // app.get('/', (req, res) => res.send('WhatsApp Call Handler OK'));

// // // const PORT = process.env.PORT || 8080;
// // // app.listen(PORT, () => {
// // //   console.log(`Server listening on ${PORT}`);
// // // });



















// // // // /**
// // // //  * server.js
// // // //  * WhatsApp Call Handler for Google Cloud Run
// // // //  *
// // // //  * - Parses incoming webhook shape matching your sample JSON.
// // // //  * - Auto-answers user-initiated calls by creating a WebRTC answer.
// // // //  * - Pushes continuous silent audio into the call (nonstandard.RTCAudioSource).
// // // //  *
// // // //  * ENV variables:
// // // //  *  VERIFY_TOKEN          - webhook verification token (string)
// // // //  *  META_ACCESS_TOKEN     - Graph API access token (string)
// // // //  *  META_API_VERSION      - e.g. v17.0 (default v23.0)
// // // //  *  META_BASE_URL         - default https://graph.facebook.com
// // // //  *  ANSWER_MODE           - "CALL_SCOPED" or "PHONE_SCOPED" (defaults to CALL_SCOPED)
// // // //  */

// // // // const express = require('express');
// // // // const bodyParser = require('body-parser');
// // // // const axios = require('axios');
// // // // const { RTCPeerConnection, nonstandard } = require('wrtc');
// // // // const { v4: uuidv4 } = require('uuid');

// // // // const app = express();
// // // // app.use(bodyParser.json({ limit: '10mb' }));

// // // // const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'change_me';
// // // // const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
// // // // const META_API_VERSION = process.env.META_API_VERSION || 'v17.0';
// // // // const META_BASE_URL = process.env.META_BASE_URL || 'https://graph.facebook.com';
// // // // const ANSWER_MODE = (process.env.ANSWER_MODE || 'CALL_SCOPED').toUpperCase(); // CALL_SCOPED | PHONE_SCOPED

// // // // if (!META_ACCESS_TOKEN) {
// // // //   console.warn('Warning: META_ACCESS_TOKEN is not set. Set it before running in production.');
// // // // }

// // // // // In-memory store for calls
// // // // const calls = new Map();

// // // // /* ---------- Webhook verification ---------- */
// // // // app.get('/webhook', (req, res) => {
// // // //   const mode = req.query['hub.mode'];
// // // //   const token = req.query['hub.verify_token'];
// // // //   const challenge = req.query['hub.challenge'];
// // // //   if (mode && token) {
// // // //     if (mode === 'subscribe' && token === VERIFY_TOKEN) {
// // // //       console.log('Webhook verified');
// // // //       return res.status(200).send(challenge);
// // // //     } else {
// // // //       return res.status(403).send('Forbidden - verify token mismatch');
// // // //     }
// // // //   }
// // // //   res.status(400).send('Bad Request');
// // // // });

// // // // /* ---------- Webhook event receiver ---------- */
// // // // app.post('/webhook', async (req, res) => {
// // // //   try {
// // // //     const body = req.body;
// // // //     console.log('Webhook payload (truncated):', JSON.stringify(body).slice(0, 800));

// // // //     const entry = body.entry || [];
// // // //     for (const ent of entry) {
// // // //       const changes = ent.changes || [];
// // // //       for (const change of changes) {
// // // //         const val = change.value || {};
// // // //         const phoneNumberId = val.metadata && val.metadata.phone_number_id;
// // // //         const callsArr = (val.calls && Array.isArray(val.calls)) ? val.calls : [];
// // // //         for (const call of callsArr) {
// // // //           const callId = call.id || call.call_id;
// // // //           const event = (call.event || '').toLowerCase();
// // // //           console.log('Call event:', event, 'callId:', callId);

// // // //           if (!callId) continue;

// // // //           if (['connect', 'offer', 'call_offer'].includes(event)) {
// // // //             const sdp = (call.session && call.session.sdp) || (call.offer && call.offer.sdp) || call.sdp;
// // // //             const sdpType = call.session && call.session.sdp_type;
// // // //             if (sdp) {
// // // //               await handleCallOffer(callId, sdp, { phoneNumberId, call });
// // // //             } else {
// // // //               console.warn('Offer missing sdp for call', callId);
// // // //             }
// // // //           } else if (['ice_candidate', 'ice', 'candidate'].includes(event)) {
// // // //             const candidateObj = call.ice || call.candidate || (call.ice && call.ice.candidate);
// // // //             if (candidateObj) {
// // // //               await handleRemoteIce(callId, candidateObj);
// // // //             } else {
// // // //               console.warn('ICE event missing candidate for', callId, call);
// // // //             }
// // // //           } else if (['hangup', 'disconnected', 'end'].includes(event)) {
// // // //             cleanupCall(callId);
// // // //           } else if (event === 'answered') {
// // // //             console.log('Call answered event for', callId);
// // // //           } else {
// // // //             console.log('Unhandled/unknown event:', event);
// // // //           }
// // // //         }
// // // //       }
// // // //     }

// // // //     res.status(200).send('EVENT_RECEIVED');
// // // //   } catch (err) {
// // // //     console.error('Webhook POST error', err);
// // // //     res.status(500).send('Server error');
// // // //   }
// // // // });

// // // // /* ---------- Call handling ---------- */
// // // // async function handleCallOffer(callId, sdpOffer, ctx) {
// // // //   console.log(`handleCallOffer: ${callId} phoneNumberId=${ctx.phoneNumberId || 'unknown'}`);

// // // //   if (calls.has(callId)) {
// // // //     console.log('Existing call state found, cleaning up before re-creating', callId);
// // // //     cleanupCall(callId);
// // // //   }

// // // //   const pc = new RTCPeerConnection({
// // // //     iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
// // // //   });

// // // //   const audioSource = new nonstandard.RTCAudioSource();
// // // //   const track = audioSource.createTrack();
// // // //   pc.addTrack(track);

// // // //   const iceCandidates = [];
// // // //   pc.onicecandidate = (e) => {
// // // //     if (e.candidate) {
// // // //       iceCandidates.push(e.candidate);
// // // //       sendLocalIceToMeta(callId, ctx.phoneNumberId, e.candidate).catch(err => {
// // // //         console.error('sendLocalIceToMeta error', err && err.message ? err.message : err);
// // // //       });
// // // //     }
// // // //   };

// // // //   pc.onconnectionstatechange = () => {
// // // //     if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
// // // //       cleanupCall(callId);
// // // //     }
// // // //   };

// // // //   await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
// // // //   const answer = await pc.createAnswer();
// // // //   await pc.setLocalDescription(answer);

// // // //   // Wait for ICE gathering complete
// // // //   await new Promise(resolve => {
// // // //     if (pc.iceGatheringState === 'complete') return resolve();
// // // //     pc.onicegatheringstatechange = () => {
// // // //       if (pc.iceGatheringState === 'complete') resolve();
// // // //     };
// // // //   });

// // // //   calls.set(callId, { pc, audioSource, track, phoneNumberId: ctx.phoneNumberId });

// // // //   // Start pushing silent audio
// // // //   const interval = startPushingSilentAudio(callId, audioSource);
// // // //   calls.get(callId).silentInterval = interval;

// // // //   try {
// // // //     await sendAnswerToMeta(callId, ctx.phoneNumberId, pc.localDescription.sdp);
// // // //     console.log('Answer sent to Meta for call', callId);
// // // //   } catch (err) {
// // // //     console.error('Failed to send answer to Meta', err?.message || err);
// // // //     cleanupCall(callId);
// // // //   }
// // // // }

// // // // async function handleRemoteIce(callId, candidateObj) {
// // // //   const state = calls.get(callId);
// // // //   if (!state) {
// // // //     console.warn('Remote ICE for unknown call', callId);
// // // //     return;
// // // //   }
// // // //   try {
// // // //     const cand = candidateObj.candidate ? candidateObj : { candidate: candidateObj };
// // // //     await state.pc.addIceCandidate(cand);
// // // //     console.log('Remote ICE added for', callId);
// // // //   } catch (err) {
// // // //     console.error('addIceCandidate error', err);
// // // //   }
// // // // }

// // // // function startPushingSilentAudio(callId, audioSource) {
// // // //   const sampleRate = 48000;
// // // //   const frameMs = 20; // 20ms frames = 960 samples
// // // //   const samples = Math.floor(sampleRate * (frameMs / 1000));
// // // //   const silentFrame = new Int16Array(samples);

// // // //   const interval = setInterval(() => {
// // // //     try {
// // // //       audioSource.onData({
// // // //         samples: silentFrame,
// // // //         sampleRate,
// // // //         bitsPerSample: 16,
// // // //         channelCount: 1
// // // //       });
// // // //     } catch (err) {
// // // //       console.error('audioSource.onData error for', callId, err);
// // // //     }
// // // //   }, frameMs);

// // // //   return interval;
// // // // }

// // // // function cleanupCall(callId) {
// // // //   const s = calls.get(callId);
// // // //   if (!s) return;
// // // //   try {
// // // //     if (s.silentInterval) clearInterval(s.silentInterval);
// // // //     if (s.track) s.track.stop();
// // // //     if (s.pc) s.pc.close();
// // // //   } catch (e) {
// // // //     console.warn('Error during cleanup', e);
// // // //   }
// // // //   calls.delete(callId);
// // // //   console.log('Cleaned up call', callId);
// // // // }

// // // // async function sendAnswerToMeta(callId, phoneNumberId, answerSdp) {
// // // //   if (!META_ACCESS_TOKEN) throw new Error('META_ACCESS_TOKEN missing');

// // // //   if (ANSWER_MODE === 'PHONE_SCOPED') {
// // // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
// // // //     const body = { type: 'answer', call_id: callId, sdp: answerSdp };
// // // //     return axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }, headers: { 'Content-Type': 'application/json' }});
// // // //   } else {
// // // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${callId}/answer`;
// // // //     const body = { sdp: answerSdp };
// // // //     return axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }, headers: { 'Content-Type': 'application/json' }});
// // // //   }
// // // // }

// // // // async function sendLocalIceToMeta(callId, phoneNumberId, candidateObj) {
// // // //   if (!META_ACCESS_TOKEN) return;
// // // //   if (ANSWER_MODE === 'PHONE_SCOPED') {
// // // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
// // // //     const body = { type: 'ice_candidate', call_id: callId, ice: candidateObj };
// // // //     try { await axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }}); } 
// // // //     catch (err) { console.error('phone-scoped sendLocalIceToMeta error', err?.response?.data || err.message); }
// // // //   } else {
// // // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${callId}/ice_candidates`;
// // // //     const body = { candidate: candidateObj };
// // // //     try { await axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }}); } 
// // // //     catch (err) { console.error('call-scoped sendLocalIceToMeta error', err?.response?.data || err.message); }
// // // //   }
// // // // }

// // // // /* ---------- health ---------- */
// // // // app.get('/', (req, res) => res.send('WhatsApp Call Handler OK'));

// // // // const PORT = process.env.PORT || 8080;
// // // // app.listen(PORT, () => {
// // // //   console.log(`Server listening on ${PORT}`);
// // // // });





















// // // // // /**
// // // // //  * server.js
// // // // //  * WhatsApp Call Handler for Google Cloud Run
// // // // //  *
// // // // //  * - Parses incoming webhook shape matching your sample JSON.
// // // // //  * - Auto-answers user-initiated calls by creating a WebRTC answer.
// // // // //  * - Pushes continuous silent audio into the call (nonstandard.RTCAudioSource).
// // // // //  *
// // // // //  * ENV variables:
// // // // //  *  VERIFY_TOKEN          - webhook verification token (string)
// // // // //  *  META_ACCESS_TOKEN     - Graph API access token (string)
// // // // //  *  META_API_VERSION      - e.g. v17.0 (default v23.0)
// // // // //  *  META_BASE_URL         - default https://graph.facebook.com
// // // // //  *  ANSWER_MODE           - "CALL_SCOPED" or "PHONE_SCOPED" (defaults to CALL_SCOPED)
// // // // //  *
// // // // //  * Notes:
// // // // //  *  - The sendAnswer/sendIce functions include two common patterns (call-scoped vs phone-scoped).
// // // // //  *    Confirm which one Meta requires from their docs or by testing. See README below.
// // // // //  */

// // // // // const express = require('express');
// // // // // const bodyParser = require('body-parser');
// // // // // const axios = require('axios');
// // // // // const { RTCPeerConnection, nonstandard } = require('wrtc');
// // // // // const { v4: uuidv4 } = require('uuid');

// // // // // const app = express();
// // // // // app.use(bodyParser.json({ limit: '10mb' }));

// // // // // const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'change_me';
// // // // // const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
// // // // // const META_API_VERSION = process.env.META_API_VERSION || 'v17.0';
// // // // // const META_BASE_URL = process.env.META_BASE_URL || 'https://graph.facebook.com';
// // // // // const ANSWER_MODE = (process.env.ANSWER_MODE || 'CALL_SCOPED').toUpperCase(); // CALL_SCOPED | PHONE_SCOPED

// // // // // if (!META_ACCESS_TOKEN) {
// // // // //   console.warn('Warning: META_ACCESS_TOKEN is not set. Set it before running in production.');
// // // // // }

// // // // // // in-memory store for calls
// // // // // const calls = new Map();

// // // // // /* ---------- Webhook verification ---------- */
// // // // // app.get('/webhook', (req, res) => {
// // // // //   const mode = req.query['hub.mode'];
// // // // //   const token = req.query['hub.verify_token'];
// // // // //   const challenge = req.query['hub.challenge'];
// // // // //   if (mode && token) {
// // // // //     if (mode === 'subscribe' && token === VERIFY_TOKEN) {
// // // // //       console.log('Webhook verified');
// // // // //       return res.status(200).send(challenge);
// // // // //     } else {
// // // // //       return res.status(403).send('Forbidden - verify token mismatch');
// // // // //     }
// // // // //   }
// // // // //   res.status(400).send('Bad Request');
// // // // // });

// // // // // /* ---------- Webhook event receiver ---------- */
// // // // // app.post('/webhook', async (req, res) => {
// // // // //   try {
// // // // //     const body = req.body;
// // // // //     console.log('Webhook payload (truncated):', JSON.stringify(body).slice(0, 800));

// // // // //     // iterate entries -> changes -> value.calls[]
// // // // //     const entry = body.entry || [];
// // // // //     for (const ent of entry) {
// // // // //       const changes = ent.changes || [];
// // // // //       for (const change of changes) {
// // // // //         const val = change.value || {};
// // // // //         const phoneNumberId = val.metadata && val.metadata.phone_number_id;
// // // // //         const callsArr = (val.calls && Array.isArray(val.calls)) ? val.calls : [];
// // // // //         for (const call of callsArr) {
// // // // //           // Example call object from you:
// // // // //           // {
// // // // //           //  "id":"wacid....",
// // // // //           //  "from":"918103416377",
// // // // //           //  "to":"917428487785",
// // // // //           //  "event":"connect",
// // // // //           //  "timestamp":"1763301256",
// // // // //           //  "direction":"USER_INITIATED",
// // // // //           //  "session": {"sdp":"v=0...","sdp_type":"offer"}
// // // // //           // }
// // // // //           const callId = call.id || call.call_id;
// // // // //           const event = (call.event || '').toLowerCase();
// // // // //           console.log('Call event:', event, 'callId:', callId);

// // // // //           if (!callId) continue;

// // // // //           if (event === 'connect' || event === 'offer' || event === 'call_offer') {
// // // // //             // The sample uses session.sdp + sdp_type (offer)
// // // // //             const sdp = (call.session && call.session.sdp) || (call.offer && call.offer.sdp) || call.sdp;
// // // // //             const sdpType = call.session && call.session.sdp_type;
// // // // //             if (sdp && sdpType && sdpType.toLowerCase().includes('offer')) {
// // // // //               await handleCallOffer(callId, sdp, { phoneNumberId, call });
// // // // //             } else if (sdp) {
// // // // //               // fallback if sdp_type absent
// // // // //               await handleCallOffer(callId, sdp, { phoneNumberId, call });
// // // // //             } else {
// // // // //               console.warn('Offer missing sdp for call', callId);
// // // // //             }
// // // // //           } else if (event === 'ice_candidate' || event === 'ice' || event === 'candidate') {
// // // // //             // Some vendors use call.ice or call.candidate
// // // // //             const candidateObj = call.ice || call.candidate || (call.ice && call.ice.candidate);
// // // // //             if (candidateObj) {
// // // // //               await handleRemoteIce(callId, candidateObj);
// // // // //             } else {
// // // // //               console.warn('ICE event missing candidate for', callId, call);
// // // // //             }
// // // // //           } else if (event === 'hangup' || event === 'disconnected' || event === 'end') {
// // // // //             cleanupCall(callId);
// // // // //           } else if (event === 'answered') {
// // // // //             console.log('Call answered event for', callId);
// // // // //           } else {
// // // // //             console.log('Unhandled/unknown event:', event);
// // // // //           }
// // // // //         }
// // // // //       }
// // // // //     }

// // // // //     res.status(200).send('EVENT_RECEIVED');
// // // // //   } catch (err) {
// // // // //     console.error('Webhook POST error', err);
// // // // //     res.status(500).send('Server error');
// // // // //   }
// // // // // });

// // // // // /* ---------- Call handling ---------- */

// // // // // async function handleCallOffer(callId, sdpOffer, ctx) {
// // // // //   console.log(`handleCallOffer: ${callId} phoneNumberId=${ctx.phoneNumberId || 'unknown'}`);

// // // // //   // If call exists, cleanup (re-negotiation)
// // // // //   if (calls.has(callId)) {
// // // // //     console.log('Existing call state found, cleaning up before re-creating', callId);
// // // // //     cleanupCall(callId);
// // // // //   }

// // // // //   // Create PeerConnection
// // // // //   const pc = new RTCPeerConnection({
// // // // //     iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
// // // // //   });

// // // // //   // Local ICE buffer
// // // // //   const localIceQueue = [];

// // // // //   pc.onicecandidate = (e) => {
// // // // //     if (e.candidate) {
// // // // //       console.log(`[${callId}] local ICE candidate generated`);
// // // // //       localIceQueue.push(e.candidate);
// // // // //       // send candidate to Meta immediately (best-effort)
// // // // //       sendLocalIceToMeta(callId, ctx.phoneNumberId, e.candidate).catch(err => {
// // // // //         console.error('sendLocalIceToMeta error', err && err.message ? err.message : err);
// // // // //       });
// // // // //     }
// // // // //   };

// // // // //   pc.onconnectionstatechange = () => {
// // // // //     console.log(`[${callId}] pc connectionState:`, pc.connectionState);
// // // // //     if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
// // // // //       cleanupCall(callId);
// // // // //     }
// // // // //   };

// // // // //   // Create silent audio source and add track
// // // // //   const audioSource = new nonstandard.RTCAudioSource();
// // // // //   const track = audioSource.createTrack();
// // // // //   pc.addTrack(track);

// // // // //   // Set remote description (offer)
// // // // //   try {
// // // // //     await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
// // // // //   } catch (err) {
// // // // //     console.error('setRemoteDescription failed', err);
// // // // //     cleanupIfExists(pc, track);
// // // // //     return;
// // // // //   }

// // // // //   // Create answer
// // // // //   const answer = await pc.createAnswer();
// // // // //   await pc.setLocalDescription(answer);

// // // // //   // store call state
// // // // //   calls.set(callId, {
// // // // //     pc,
// // // // //     audioSource,
// // // // //     track,
// // // // //     localIceQueue,
// // // // //     phoneNumberId: ctx.phoneNumberId,
// // // // //     createdAt: Date.now()
// // // // //   });

// // // // //   // start silent audio push
// // // // //   const interval = startPushingSilentAudio(callId, audioSource);
// // // // //   calls.get(callId).silentInterval = interval;

// // // // //   // Send answer to Meta
// // // // //   try {
// // // // //     await sendAnswerToMeta(callId, ctx.phoneNumberId, answer.sdp);
// // // // //     console.log('Posted answer to Meta for call', callId);
// // // // //   } catch (err) {
// // // // //     console.error('Failed to POST answer to Meta for call', callId, err && err.message ? err.message : err);
// // // // //     cleanupCall(callId);
// // // // //   }
// // // // // }

// // // // // function cleanupIfExists(pc, track) {
// // // // //   try {
// // // // //     if (track) track.stop();
// // // // //     if (pc) pc.close();
// // // // //   } catch (e) {}
// // // // // }

// // // // // async function handleRemoteIce(callId, candidateObj) {
// // // // //   const state = calls.get(callId);
// // // // //   if (!state) {
// // // // //     console.warn('Received remote ICE for unknown call', callId);
// // // // //     return;
// // // // //   }
// // // // //   try {
// // // // //     // candidateObj might be a string or full object. Normalize for addIceCandidate.
// // // // //     // Example from Meta may already be full candidate with candidate, sdpMid, sdpMLineIndex
// // // // //     const cand = candidateObj.candidate ? candidateObj : { candidate: candidateObj };
// // // // //     await state.pc.addIceCandidate(cand);
// // // // //     console.log('Added remote ICE to pc for', callId);
// // // // //   } catch (err) {
// // // // //     console.error('Error addIceCandidate', err);
// // // // //   }
// // // // // }
// // // // // //===================================================================
// // // // // // function startPushingSilentAudio(callId, audioSource) {
// // // // // //   // 48kHz, 16-bit, mono. 20ms frames => 960 samples
// // // // // //   const sampleRate = 48000;
// // // // // //   const frameMs = 20;
// // // // // //   const samples = Math.floor(sampleRate * (frameMs / 1000));
// // // // // //   const silentFrame = new Int16Array(samples);

// // // // // //   const interval = setInterval(() => {
// // // // // //     try {
// // // // // //       audioSource.onData({
// // // // // //         samples: silentFrame,
// // // // // //         sampleRate,
// // // // // //         bitsPerSample: 16,
// // // // // //         channelCount: 1
// // // // // //       });
// // // // // //     } catch (err) {
// // // // // //       console.error('audioSource.onData error for', callId, err);
// // // // // //     }
// // // // // //   }, frameMs);

// // // // // //   return interval;
// // // // // // }

// // // // // function startPushingSilentAudio(callId, audioSource) {
// // // // //   // Use 10ms frames which matches the expectation of the RTCAudioSource binding.
// // // // //   // At 48000 Hz: 48000 * 0.010 = 480 samples per frame.
// // // // //   const sampleRate = 48000;
// // // // //   const frameMs = 10;               // <-- changed from 20 to 10
// // // // //   const samples = Math.floor(sampleRate * (frameMs / 1000)); // 480
// // // // //   // Int16Array length = samples; byteLength = samples * 2 = 960 bytes (what binding expects)
// // // // //   const silentFrame = new Int16Array(samples);

// // // // //   const interval = setInterval(() => {
// // // // //     try {
// // // // //       audioSource.onData({
// // // // //         samples: silentFrame,
// // // // //         sampleRate,
// // // // //         bitsPerSample: 16,
// // // // //         channelCount: 1
// // // // //       });
// // // // //     } catch (err) {
// // // // //       console.error('audioSource.onData error for', callId, err);
// // // // //     }
// // // // //   }, frameMs);

// // // // //   return interval;
// // // // // }


// // // // // //========================================


// // // // // function cleanupCall(callId) {
// // // // //   const s = calls.get(callId);
// // // // //   if (!s) return;
// // // // //   try {
// // // // //     if (s.silentInterval) clearInterval(s.silentInterval);
// // // // //     if (s.track) s.track.stop();
// // // // //     if (s.pc) s.pc.close();
// // // // //   } catch (e) {
// // // // //     console.warn('Error during cleanup', e);
// // // // //   }
// // // // //   calls.delete(callId);
// // // // //   console.log('Cleaned up call', callId);
// // // // // }

// // // // // /* ---------- Meta Graph calls: send answer & ICE ---------- */

// // // // // /**
// // // // //  * sendAnswerToMeta:
// // // // //  * - Supports two common endpoint patterns:
// // // // //  *   A) CALL_SCOPED: POST /{CALL_ID}/answer
// // // // //  *   B) PHONE_SCOPED: POST /{PHONE_NUMBER_ID}/calls with body { type: 'answer', call_id: <callId>, sdp: <sdp> }
// // // // //  *
// // // // //  * Set ANSWER_MODE env to select behavior. Check Meta docs and set accordingly.
// // // // //  */
// // // // // async function sendAnswerToMeta(callId, phoneNumberId, answerSdp) {
// // // // //   if (!META_ACCESS_TOKEN) {
// // // // //     throw new Error('META_ACCESS_TOKEN missing');
// // // // //   }

// // // // //   if (ANSWER_MODE === 'PHONE_SCOPED') {
// // // // //     // phone-scoped variant
// // // // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
// // // // //     const body = {
// // // // //       type: 'answer',
// // // // //       call_id: callId,
// // // // //       sdp: answerSdp
// // // // //     };
// // // // //     console.log('Sending PHONE_SCOPED answer to', url);
// // // // //     const res = await axios.post(url, body, {
// // // // //       params: { access_token: META_ACCESS_TOKEN },
// // // // //       headers: { 'Content-Type': 'application/json' }
// // // // //     });
// // // // //     return res.data;
// // // // //   } else {
// // // // //     // call-scoped variant
// // // // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${callId}/answer`;
// // // // //     const body = { sdp: answerSdp };
// // // // //     console.log('Sending CALL_SCOPED answer to', url);
// // // // //     const res = await axios.post(url, body, {
// // // // //       params: { access_token: META_ACCESS_TOKEN },
// // // // //       headers: { 'Content-Type': 'application/json' }
// // // // //     });
// // // // //     return res.data;
// // // // //   }
// // // // // }

// // // // // /**
// // // // //  * sendLocalIceToMeta:
// // // // //  * Similar dual-mode support. Candidate payloads vary slightly per integration.
// // // // //  */
// // // // // async function sendLocalIceToMeta(callId, phoneNumberId, candidateObj) {
// // // // //   if (!META_ACCESS_TOKEN) {
// // // // //     console.warn('META_ACCESS_TOKEN missing, skipping sendLocalIceToMeta');
// // // // //     return;
// // // // //   }
// // // // //   if (ANSWER_MODE === 'PHONE_SCOPED') {
// // // // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/calls`;
// // // // //     const body = {
// // // // //       type: 'ice_candidate',
// // // // //       call_id: callId,
// // // // //       ice: {
// // // // //         candidate: candidateObj.candidate,
// // // // //         sdpMid: candidateObj.sdpMid,
// // // // //         sdpMLineIndex: candidateObj.sdpMLineIndex
// // // // //       }
// // // // //     };
// // // // //     try {
// // // // //       await axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }});
// // // // //     } catch (err) {
// // // // //       console.error('phone-scoped sendLocalIceToMeta error', err && err.response ? err.response.data : err.message);
// // // // //     }
// // // // //   } else {
// // // // //     const url = `${META_BASE_URL}/${META_API_VERSION}/${callId}/ice_candidates`;
// // // // //     const body = {
// // // // //       candidate: {
// // // // //         candidate: candidateObj.candidate,
// // // // //         sdpMid: candidateObj.sdpMid,
// // // // //         sdpMLineIndex: candidateObj.sdpMLineIndex
// // // // //       }
// // // // //     };
// // // // //     try {
// // // // //       await axios.post(url, body, { params: { access_token: META_ACCESS_TOKEN }});
// // // // //     } catch (err) {
// // // // //       console.error('call-scoped sendLocalIceToMeta error', err && err.response ? err.response.data : err.message);
// // // // //     }
// // // // //   }
// // // // // }

// // // // // /* ---------- health ---------- */
// // // // // app.get('/', (req, res) => res.send('WhatsApp Call Handler OK'));

// // // // // const PORT = process.env.PORT || 8080;
// // // // // app.listen(PORT, () => {
// // // // //   console.log(`Server listening on ${PORT}`);
// // // // // });
