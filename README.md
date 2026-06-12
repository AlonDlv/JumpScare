<div align="center">
  <img src="public/death.png" alt="JumpsCare Logo" width="128" height="128">

  # JumpsCare

  **A Chrome extension for Netflix that helps you prepare for jumpscares while watching horror movies.**

  [![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Available-blue?logo=googlechrome)](https://chrome.google.com/webstore) <!-- Add your link here later! -->
  [![React](https://img.shields.io/badge/React-18.2.0-blue?logo=react)](https://reactjs.org/)
  [![Vite](https://img.shields.io/badge/Vite-5.0.0-purple?logo=vite)](https://vitejs.dev/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

</div>

---

## 🎬 Overview

Love horror movies but hate the heart-stopping jumpscares? **JumpsCare** is your ultimate movie companion for Netflix!

Instead of being caught off guard by sudden loud scares, the extension tracks the current title and playback time, and automatically warns you or protects you right before a jumpscare happens. 

## ✨ Features

- ⚠️ **On-Screen Warnings:** Displays a sleek, pulsing visual countdown ("JUMPSCARE IN 3s") right before the scary moment.
- 🔇 **Auto-Mute:** Automatically mutes the audio exactly when the jumpscare hits, and unmutes right after it passes.
- 🌫️ **Auto-Blur:** Automatically applies a strong blur over the video player during the jumpscare so you don't have to cover your eyes.
- ⚙️ **Fully Customizable:** Toggle warnings, muting, and blurring individually, and adjust how many seconds in advance you want the warning to trigger.
- ☁️ **Cloud Database:** Seamlessly connects to an AWS API to fetch the latest jumpscare timestamps for the specific movie you are watching.

## 🛠️ Tech Stack

- **Frontend:** React, JavaScript, TypeScript, CSS
- **Build Tool:** Vite
- **Platform:** Chrome Extension APIs (Manifest V3)
- **Backend/Data:** AWS API Gateway / Lambda (for fetching timestamps)

## 🚀 Installation

If you want to build the extension from source:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/AlonDlv/JumpScare.git
   cd JumpScare
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the project:**
   ```bash
   npm run build
   ```
   *This will generate a `dist` folder containing the compiled extension.*

4. **Load the extension in Chrome:**
   - Open Chrome and navigate to `chrome://extensions/`
   - Turn on **Developer mode** in the top right corner.
   - Click **Load unpacked**.
   - Select the `dist` folder that was generated in the previous step.

## 🎮 Usage

1. Open **Netflix** in Chrome and start playing a movie.
2. Click on the **JumpsCare** icon in your browser toolbar to open the popup.
3. Toggle the features you want:
   - **Warn:** Shows the visual countdown.
   - **Mute:** Mutes the video during the scare.
   - **Blur:** Blurs the screen during the scare.
4. Set your preferred **Timer** (how many seconds before the scare you want the warning/action to start).
5. Sit back and enjoy the movie without the heart attack! The extension will automatically detect the title, fetch the timestamps, and protect you.

## ⚠️ Notes & Limitations

- The extension relies on predefined timestamp data. If a movie's jumpscares aren't in the database, the extension will display that no data was found.
- It currently only supports Netflix (`*://*.netflix.com/watch*`).
- Accuracy depends on how well the title matches the database and Netflix's player UI changes.

## ⚖️ Disclaimer

This is an independent personal project and is **not affiliated with, endorsed by, or associated with Netflix**.

## 👨‍💻 Author

**Alon Dolev**
- GitHub: [@AlonDlv](https://github.com/AlonDlv)
