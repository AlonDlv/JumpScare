# JumpsCare

JumpScare is a Chrome extension for Netflix that helps users prepare for upcoming jump scares while watching horror content.

The extension uses a local dataset of jump-scare timestamps and connects it to the current Netflix playback, allowing the user to get a warning before a scare happens.

## Main Idea

Instead of being caught off guard by sudden scare moments, the extension tracks the current title and playback time, then checks whether a known jump scare is approaching.

## Tech Stack

- React
- Vite
- JavaScript
- Chrome Extension APIs
- CSS

## Installation

1. Clone the repository

    git clone https://github.com/AlonDlv/JumpScare.git
    cd JumpScare

2. Install dependencies

    npm install

3. Build the project

    npm run build

4. Load the extension in Chrome

- Open `chrome://extensions/`
- Turn on **Developer mode**
- Click **Load unpacked**
- Select the project folder or build folder containing the extension files

## Usage

1. Open Netflix in Chrome
2. Start playing supported content
3. Open the extension popup
4. Enable warnings and choose a timer
5. The extension will display the detected title and the time until the next jump scare

## Notes

- The extension depends on predefined timestamp data
- It currently focuses on Netflix
- Accuracy depends on the title match and the dataset

## Disclaimer

This project is an independent personal project and is not affiliated with or endorsed by Netflix.

## Author

Alon Dolev
