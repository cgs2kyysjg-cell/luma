// src/twilio.js
// Helpers for sending WhatsApp messages back through Twilio + verifying signatures.

const twilio = require("twilio");

let _client = null;
function client() {
  if (_client) return _client;
  if (process.env.USE_MOCK_APIS === "true") return null;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required. Set in .env or use USE_MOCK_APIS=true.",
    );
  }
  _client = twilio(sid, token);
  return _client;
}

const FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

/**
 * Send a WhatsApp message via Twilio.
 * @param {string} to - "whatsapp:+xxx" formatted recipient
 * @param {string} body
 */
async function sendWhatsApp(to, body) {
  if (process.env.USE_MOCK_APIS === "true") {
    console.log(`[mock-twilio] would send to ${to}:\n${body}\n`);
    return { sid: "MOCK_SID", to, from: FROM, body };
  }
  return client().messages.create({ from: FROM, to, body });
}

/**
 * Verify the X-Twilio-Signature header on incoming webhook requests.
 * Returns true if the request is authenticated.
 */
function verifyTwilioSignature(req, fullUrl) {
  if (process.env.ALLOW_UNSIGNED_REQUESTS === "true") return true;
  if (process.env.USE_MOCK_APIS === "true") return true;

  const sig = req.headers["x-twilio-signature"];
  if (!sig) return false;

  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    sig,
    fullUrl,
    req.body,
  );
}

module.exports = { sendWhatsApp, verifyTwilioSignature, FROM };
