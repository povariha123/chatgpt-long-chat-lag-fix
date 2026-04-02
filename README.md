# 🚀 ChatGPT Long Chat Lag Fix

A lightweight **Tampermonkey userscript** that makes long ChatGPT conversations feel **faster, smoother, and more responsive**.

When a chat gets very long, the page can start lagging because too many message elements stay in the DOM at once. This script improves performance by **virtualizing older messages** and keeping only the most relevant part of the conversation fully active.

## ✨ What it does

- ⚡ speeds up long ChatGPT conversations
- 🧹 reduces DOM load by hiding older messages from the live UI
- 🪶 makes scrolling, typing, and clicking feel smoother
- 📦 restores older messages in batches when you scroll upward
- 🎛️ adds a simple floating control button
- 👀 avoids aggressive changes while ChatGPT is still generating a response

## 🧠 How it works

The script uses a **virtualized UI** approach:

- the most recent messages stay fully active
- older messages are temporarily replaced with lightweight placeholders
- their space in the chat is preserved
- when you scroll up, hidden messages are restored gradually

This keeps the conversation structure intact while making the browser do much less work.

## 🔥 Why it helps

Very long chats can slow down because the browser has to:

- render a lot of message blocks
- recalculate layout for a huge DOM tree
- keep scrolling and interaction responsive at the same time

By reducing how many old messages remain live in the DOM, the interface becomes noticeably lighter.

## ✅ Features

- automatic virtualization of older messages
- streaming-aware behavior
- batch restore while scrolling upward
- floating on/off control button
- soft visual optimizations for better responsiveness
- support for:

  - `https://chatgpt.com/*`
  - `https://chat.openai.com/*`

## 📥 Installation

### 1. Install Tampermonkey
Install the **Tampermonkey** browser extension.

### 2. Add the script
Create a new userscript in Tampermonkey and paste the contents of:

`ChatGPT Long Chat Lag Fix (Virtualized UI)-1.0.0.user.js`

### 3. Save and enable it
Save the script and make sure it is enabled.

### 4. Open ChatGPT
Open ChatGPT and go into any long conversation.

The script will start automatically. 🎉

## 🕹️ Usage

After loading ChatGPT, the script works on its own.

A floating button appears in the bottom-right corner:

- **Left click** — enable or disable optimization
- **Right click** — restore all hidden messages

When optimization is active, the button shows:

- **live** — how many messages are currently still active in the DOM
- **hidden** — how many older messages are currently virtualized

When you scroll near the top of the chat, older hidden messages return automatically in small batches.

## ⚙️ Default config

```js
const CONFIG = {
  keepLast: 6,
  revealBatch: 5,
  topRevealZonePx: 300,
  settleDelayMs: 1200,
  controlButton: true,
  softVisualOptimizations: true,
  debug: false,
};
