import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './App.css';
import logo from './assets/JumpsCareLogo.png';
import spiderImg from './assets/spider.png';
import {
  DEFAULT_SETTINGS,
  MAX_TIMER,
  MIN_TIMER,
  loadSettings,
  saveSettings,
  subscribeToSettings
} from './extension-settings';

const DOT_SIZE = 28;
const NETFLIX_WATCH_URL = /^https?:\/\/(?:www\.)?netflix\.com\/watch\//i;

function queryActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0] ?? null);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(response ?? null);
    });
  });
}

function injectContentScript(tabId) {
  if (!chrome.scripting?.executeScript) {
    return Promise.resolve(false);
  }

  return new Promise(resolve => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ['content.js']
      },
      () => {
        resolve(!chrome.runtime.lastError);
      }
    );
  });
}

async function requestPlaybackState(tab) {
  if (!tab?.id || !NETFLIX_WATCH_URL.test(tab.url ?? '')) {
    return null;
  }

  const initialResponse = await sendMessageToTab(tab.id, { action: 'getState' });
  if (initialResponse) {
    return initialResponse;
  }

  const injected = await injectContentScript(tab.id);
  if (!injected) {
    return null;
  }

  return sendMessageToTab(tab.id, { action: 'getState' });
}

export default function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [movieTitle, setMovieTitle] = useState(null);
  const [secondsToNextScare, setSecondsToNextScare] = useState(null);
  const [currentTime, setCurrentTime] = useState(null);
  const [expandedControl, setExpandedControl] = useState(null);
  const [showBugReport, setShowBugReport] = useState(false);
  const [bugText, setBugText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const pendingExpandRef = useRef(null);

  const handleSendBug = async () => {
    if (!bugText.trim()) return;
    
    let formattedTime = 'Unknown';
    if (currentTime !== null) {
      const h = Math.floor(currentTime / 3600);
      const m = Math.floor((currentTime % 3600) / 60);
      const s = Math.floor(currentTime % 60);
      formattedTime = h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
    }

    const fullMessage = `${bugText}\n\n---\nDiagnostic Info:\nStreaming Service: Netflix\nMovie Title: ${movieTitle || 'Unknown'}\nCurrent Time: ${formattedTime}`;

    setIsSending(true);
    try {
      await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          access_key: 'd1d5fde6-bcb5-4f11-91df-2100482235b8',
          subject: 'New Bug Report - JumpScare Extension',
          message: fullMessage,
          from_name: 'JumpScare User'
        })
      });
    } catch (error) {
      console.error('Error sending bug report:', error);
    } finally {
      setIsSending(false);
      setShowBugReport(false);
      setBugText("");
    }
  };

  const toggleExpand = (controlName) => {
    if (expandedControl === controlName) {
      setExpandedControl(null);
      pendingExpandRef.current = null;
    } else if (expandedControl !== null) {
      setExpandedControl(null);
      pendingExpandRef.current = controlName;
      setTimeout(() => {
        if (pendingExpandRef.current === controlName) {
          setExpandedControl(controlName);
          pendingExpandRef.current = null;
        }
      }, 400); // Wait for the max-height transition to finish
    } else {
      setExpandedControl(controlName);
      pendingExpandRef.current = null;
    }
  };

  useEffect(() => {
    if (expandedControl !== null) {
      if (!settings.enabled || settings[expandedControl] === false) {
        setExpandedControl(null);
        pendingExpandRef.current = null;
      }
    }
  }, [settings.enabled, settings.mute, settings.warn, settings.blur, expandedControl]);

  const rangeRef = useRef(null);
  const [rangeWidth, setRangeWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void loadSettings().then(loadedSettings => {
      if (!cancelled) {
        setSettings(loadedSettings);
      }
    });

    const unsubscribe = subscribeToSettings(nextSettings => {
      if (!cancelled) {
        setSettings(nextSettings);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useLayoutEffect(() => {
    const updateWidth = () => {
      if (rangeRef.current) {
        setRangeWidth(rangeRef.current.offsetWidth);
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);

    return () => {
      window.removeEventListener('resize', updateWidth);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const clearPlaybackState = () => {
      if (cancelled) {
        return;
      }

      setMovieTitle(null);
      setSecondsToNextScare(null);
      setCurrentTime(null);
    };

    const syncPlaybackState = async () => {
      const activeTab = await queryActiveTab();
      if (cancelled) {
        return;
      }

      if (!activeTab?.id || !NETFLIX_WATCH_URL.test(activeTab.url ?? '')) {
        clearPlaybackState();
        return;
      }

      const response = await requestPlaybackState(activeTab);
      if (cancelled || !response) {
        return;
      }

      const nextTitle =
        typeof response.title === 'string' && response.title.trim()
          ? response.title.trim()
          : null;
      const nextSecondsToNextScare =
        typeof response.secondsToNextScare === 'number' &&
        Number.isFinite(response.secondsToNextScare)
          ? response.secondsToNextScare
          : null;
      const nextCurrentTime =
        typeof response.currentTime === 'number' &&
        Number.isFinite(response.currentTime)
          ? response.currentTime
          : null;

      setMovieTitle(previousTitle => nextTitle ?? previousTitle);
      setSecondsToNextScare(nextSecondsToNextScare);
      setCurrentTime(nextCurrentTime);
    };

    void syncPlaybackState();
    const intervalId = window.setInterval(() => {
      void syncPlaybackState();
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const updateSetting = (key, value) => {
    setSettings(previousSettings => ({
      ...previousSettings,
      [key]: value
    }));

    void saveSettings({ [key]: value });
  };

  const updateFeatureToggle = (feature, newValue) => {
    if (newValue) {
      const updates = {
        [feature]: true,
        [`${feature}Major`]: true,
        [`${feature}Minor`]: true
      };
      setSettings(previousSettings => ({
        ...previousSettings,
        ...updates
      }));
      void saveSettings(updates);
    } else {
      updateSetting(feature, false);
    }
  };

  const usableWidth = Math.max(rangeWidth - DOT_SIZE, 0);
  const sliderFraction = (settings.timer - MIN_TIMER) / (MAX_TIMER - MIN_TIMER);
  const sliderLeft = usableWidth * sliderFraction + DOT_SIZE / 2;
  const areFeatureTogglesDisabled = !settings.enabled;
  const isTimerDisabled = !settings.enabled;

  return (
    <div className="container">
      <img 
        src={spiderImg} 
        alt="Spider decoration" 
        className="spider-decoration" 
        onClick={() => setShowBugReport(true)}
      />
      <img src={logo} alt="JumpScare Logo" className="logo" />

      <div className="control">
        <label htmlFor="extension-toggle">EXTENSION</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="extension-toggle"
            checked={settings.enabled}
            onChange={() => updateSetting('enabled', !settings.enabled)}
          />
          <span className="slider" />
        </div>
      </div>

      <div className={`control-wrapper ${expandedControl === 'mute' ? 'is-expanded' : ''} ${areFeatureTogglesDisabled ? 'is-disabled' : ''}`}>
        <div className="main-control">
          <label 
            onClick={() => toggleExpand('mute')} 
            className={`feature-label ${expandedControl === 'mute' ? 'blood-fill' : ''}`}
          >
            MUTE
          </label>
          <div className="toggle">
            <input
              type="checkbox"
              id="mute"
              checked={settings.mute}
              disabled={areFeatureTogglesDisabled}
              onChange={() => updateFeatureToggle('mute', !settings.mute)}
            />
            <span className="slider" />
          </div>
        </div>
        <div className="sub-controls">
          <div className="sub-control">
            <label htmlFor="muteMajor">Major</label>
            <div className="toggle scale-down">
              <input type="checkbox" id="muteMajor" checked={settings.muteMajor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('muteMajor', !settings.muteMajor)} />
              <span className="slider" />
            </div>
          </div>
          <div className="sub-control">
            <label htmlFor="muteMinor">Minor</label>
            <div className="toggle scale-down">
              <input type="checkbox" id="muteMinor" checked={settings.muteMinor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('muteMinor', !settings.muteMinor)} />
              <span className="slider" />
            </div>
          </div>
        </div>
      </div>

      <div className={`control-wrapper ${expandedControl === 'blur' ? 'is-expanded' : ''} ${areFeatureTogglesDisabled ? 'is-disabled' : ''}`}>
        <div className="main-control">
          <label 
            onClick={() => toggleExpand('blur')} 
            className={`feature-label ${expandedControl === 'blur' ? 'blood-fill' : ''}`}
          >
            BLUR
          </label>
          <div className="toggle">
            <input
              type="checkbox"
              id="blur"
              checked={settings.blur}
              disabled={areFeatureTogglesDisabled}
              onChange={() => updateFeatureToggle('blur', !settings.blur)}
            />
            <span className="slider" />
          </div>
        </div>
        <div className="sub-controls">
          <div className="sub-control">
            <label htmlFor="blurMajor">Major</label>
            <div className="toggle scale-down">
              <input type="checkbox" id="blurMajor" checked={settings.blurMajor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('blurMajor', !settings.blurMajor)} />
              <span className="slider" />
            </div>
          </div>
          <div className="sub-control">
            <label htmlFor="blurMinor">Minor</label>
            <div className="toggle scale-down">
              <input type="checkbox" id="blurMinor" checked={settings.blurMinor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('blurMinor', !settings.blurMinor)} />
              <span className="slider" />
            </div>
          </div>
        </div>
      </div>

      <div className={`control-wrapper ${expandedControl === 'warn' ? 'is-expanded' : ''} ${areFeatureTogglesDisabled ? 'is-disabled' : ''}`}>
        <div className="main-control">
          <label 
            onClick={() => toggleExpand('warn')} 
            className={`feature-label ${expandedControl === 'warn' ? 'blood-fill' : ''}`}
          >
            WARN
          </label>
          <div className="toggle">
            <input
              type="checkbox"
              id="warn"
              checked={settings.warn}
              disabled={areFeatureTogglesDisabled}
              onChange={() => updateFeatureToggle('warn', !settings.warn)}
            />
            <span className="slider" />
          </div>
        </div>
        <div className="sub-controls">
          <div className="sub-control">
            <label htmlFor="warnMajor">Major</label>
            <div className="toggle scale-down">
              <input type="checkbox" id="warnMajor" checked={settings.warnMajor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('warnMajor', !settings.warnMajor)} />
              <span className="slider" />
            </div>
          </div>
          <div className="sub-control">
            <label htmlFor="warnMinor">Minor</label>
            <div className="toggle scale-down">
              <input type="checkbox" id="warnMinor" checked={settings.warnMinor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('warnMinor', !settings.warnMinor)} />
              <span className="slider" />
            </div>
          </div>
        </div>
      </div>

      <div className={`control ${isTimerDisabled ? 'is-disabled' : ''}`} style={{ marginTop: '8px', padding: '16px', flexDirection: 'column', alignItems: 'stretch', borderRadius: '22px' }}>
        <label htmlFor="timer">TIMER</label>
        <div className={`range-container ${isTimerDisabled ? 'is-disabled' : ''}`}>
          <input
            ref={rangeRef}
            type="range"
            id="timer"
            min={MIN_TIMER}
            max={MAX_TIMER}
            value={settings.timer}
            disabled={isTimerDisabled}
            onChange={event => updateSetting('timer', Number(event.target.value))}
          />
          <div
            className={`range-value ${isTimerDisabled ? 'is-disabled' : ''}`}
            style={{ left: `${sliderLeft}px` }}
          >
            {settings.timer}
          </div>
        </div>
      </div>

      <div className="control info-control">
        <label>TITLE</label>
        <span className="info-value">{movieTitle || 'NONE'}</span>
      </div>

      <div className="control info-control">
        <label>NEXT SCARE</label>
        <span className="info-value">
          {secondsToNextScare != null ? `${secondsToNextScare}s` : '--'}
        </span>
      </div>

      {showBugReport && (
        <div className="bug-report-overlay">
          <h2 className="bug-report-title">Report a Bug</h2>
          <textarea 
            className="bug-report-textarea"
            placeholder="Describe the bug here..."
            value={bugText}
            onChange={(e) => setBugText(e.target.value)}
          />
          <p className="bug-report-disclaimer">
            Note: This report will automatically include the current movie title, playback time, and streaming service to help us debug faster.
          </p>
          <div className="bug-report-actions">
            <button className="bug-report-btn cancel" onClick={() => { setShowBugReport(false); setBugText(""); }} disabled={isSending}>Cancel</button>
            <button className="bug-report-btn send" onClick={handleSendBug} disabled={isSending || !bugText.trim()}>
              {isSending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
