#!/usr/bin/env bash
# scripts/setup.sh
# One-command setup. Run from the project root: bash scripts/setup.sh

set -euo pipefail

echo "→ luma prototype setup"
echo ""

# 1. Check Node version
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is not installed. Install Node 20+ first."
  echo "  brew install node    (macOS)"
  echo "  https://nodejs.org   (anywhere)"
  exit 1
fi

NODE_MAJOR=$(node -p "parseInt(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node $NODE_MAJOR detected. Need Node 20+."
  exit 1
fi

echo "✓ Node $(node -v)"

# 2. Install dependencies
echo ""
echo "→ Installing dependencies (npm install)…"
npm install

# 3. Bootstrap .env
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo ""
    echo "✓ Created .env from .env.example"
    echo ""
    echo "  ⚠️  IMPORTANT: edit .env and add your API keys before running:"
    echo "       - ANTHROPIC_API_KEY"
    echo "       - OPENAI_API_KEY"
    echo "       - TWILIO_ACCOUNT_SID"
    echo "       - TWILIO_AUTH_TOKEN"
  fi
else
  echo "✓ .env already exists"
fi

# 4. Run adversarial test (no API keys needed)
echo ""
echo "→ Running safety filter tests (no API needed)…"
node scripts/test-adversarial.js || {
  echo "✗ Safety tests failed. See output above."
  exit 1
}

echo ""
echo "✓ Setup complete."
echo ""
echo "Next steps:"
echo "  1. Edit .env and add your API keys."
echo "  2. Run 'npm run ingest' to build the embeddings index."
echo "  3. Run 'npm start' to launch the server on port 3000."
echo "  4. Use ngrok or a similar tunnel to expose localhost to Twilio."
echo "  5. Configure your Twilio Sandbox webhook to:"
echo "     https://<your-tunnel-url>/webhooks/twilio/whatsapp"
echo ""
echo "Or skip the API setup and run with mocks:"
echo "  USE_MOCK_APIS=true npm run test:claude"
