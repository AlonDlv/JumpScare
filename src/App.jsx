import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './App.css';
import logo from './assets/JumpsCareLogo.png';
import spiderImg from './assets/spider.png';
import settingsIcon from './assets/settings-icon.png';
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

function formatSecondsToTime(totalSeconds) {
  if (totalSeconds == null) return '';
  if (typeof totalSeconds === 'string' && totalSeconds.includes(':')) return totalSeconds;
  const secs = Math.floor(Number(totalSeconds));
  if (isNaN(secs)) return totalSeconds;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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
  const [showSettings, setShowSettings] = useState(false);
  const [bugText, setBugText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [movieJumpscares, setMovieJumpscares] = useState([]);
  const [modifiedTimestamps, setModifiedTimestamps] = useState({});
  const [customJumpscares, setCustomJumpscares] = useState({});
  const pendingExpandRef = useRef(null);

  useEffect(() => {
    chrome.storage.local.get(['bugReportTimestamps', 'customJumpscares'], (result) => {
      if (result.bugReportTimestamps) {
        const migrated = { ...result.bugReportTimestamps };
        for (const title in migrated) {
          for (const idx in migrated[title]) {
             let mod = migrated[title][idx];
             if (typeof mod !== 'object' && mod !== undefined) {
               mod = { time: mod };
             }
             if (mod && mod.time !== undefined && !String(mod.time).includes(':') && !isNaN(Number(mod.time))) {
               mod.time = formatSecondsToTime(Number(mod.time));
             }
             migrated[title][idx] = mod;
          }
        }
        setModifiedTimestamps(migrated);
      }
      if (result.customJumpscares) {
        setCustomJumpscares(result.customJumpscares);
      }
    });
  }, []);

  const handleScareEdit = (index, field, value) => {
    const titleKey = movieTitle || 'Unknown';
    const currentTitleMods = modifiedTimestamps[titleKey] || {};
    let scareMods = currentTitleMods[index];
    
    // Migration check
    if (typeof scareMods !== 'object' && scareMods !== undefined) {
      scareMods = { time: scareMods };
    } else {
      scareMods = scareMods || {};
    }

    const updated = {
      ...modifiedTimestamps,
      [titleKey]: {
        ...currentTitleMods,
        [index]: {
          ...scareMods,
          [field]: value
        }
      }
    };
    setModifiedTimestamps(updated);
    chrome.storage.local.set({ bugReportTimestamps: updated });
  };

  const currentTitleConfig = customJumpscares[movieTitle || 'Unknown'] || { useCustom: false, scares: [] };

  const handleCustomToggle = () => {
    const titleKey = movieTitle || 'Unknown';
    const isNowCustom = !currentTitleConfig.useCustom;
    const updated = {
      ...customJumpscares,
      [titleKey]: {
        ...currentTitleConfig,
        useCustom: isNowCustom,
        scares: currentTitleConfig.scares.length > 0 ? currentTitleConfig.scares : (movieJumpscares || []).map(js => ({...js, time: formatSecondsToTime(js.time)}))
      }
    };
    setCustomJumpscares(updated);
    chrome.storage.local.set({ customJumpscares: updated });
    
    if (isNowCustom && expandedControl !== 'setjumpscares') {
      toggleExpand('setjumpscares');
    } else if (!isNowCustom && expandedControl === 'setjumpscares') {
      toggleExpand('setjumpscares');
    }
  };

  const addCustomScare = () => {
    const titleKey = movieTitle || 'Unknown';
    const updated = {
      ...customJumpscares,
      [titleKey]: {
        ...currentTitleConfig,
        scares: [...currentTitleConfig.scares, { time: '', severity: 'Minor' }]
      }
    };
    setCustomJumpscares(updated);
    chrome.storage.local.set({ customJumpscares: updated });
  };

  const updateCustomScare = (index, field, value) => {
    const titleKey = movieTitle || 'Unknown';
    const newScares = [...currentTitleConfig.scares];
    newScares[index] = { ...newScares[index], [field]: value };
    const updated = {
      ...customJumpscares,
      [titleKey]: {
        ...currentTitleConfig,
        scares: newScares
      }
    };
    setCustomJumpscares(updated);
    chrome.storage.local.set({ customJumpscares: updated });
  };

  const removeCustomScare = (index) => {
    const titleKey = movieTitle || 'Unknown';
    const newScares = [...currentTitleConfig.scares];
    newScares.splice(index, 1);
    const updated = {
      ...customJumpscares,
      [titleKey]: {
        ...currentTitleConfig,
        scares: newScares
      }
    };
    setCustomJumpscares(updated);
    chrome.storage.local.set({ customJumpscares: updated });
  };

  const handleSendBug = async () => {
    if (!bugText.trim()) return;
    
    let formattedTime = 'Unknown';
    if (currentTime !== null) {
      formattedTime = formatSecondsToTime(currentTime);
    }

    let timestampsInfo = "";
    if (movieJumpscares && movieJumpscares.length > 0) {
      const titleKey = movieTitle || 'Unknown';
      const userMods = modifiedTimestamps[titleKey] || {};
      const finalScares = movieJumpscares.map((js, idx) => {
        let mod = userMods[idx];
        if (typeof mod !== 'object' && mod !== undefined) {
          mod = { time: mod };
        } else {
          mod = mod || {};
        }
        return {
          ...js,
          time: mod.time !== undefined && mod.time !== '' ? mod.time : formatSecondsToTime(js.time),
          severity: mod.severity !== undefined ? mod.severity : js.severity,
          removed: mod.removed || false,
          modified: Object.keys(mod).length > 0
        };
      });
      timestampsInfo = `\n\nTimestamps:\n` + finalScares.map(s => {
        if (s.removed) return `[REMOVED] ${s.severity}: ${s.time}`;
        return `${s.severity}: ${s.time}${s.modified ? ' (modified)' : ''}`;
      }).join('\n');
    }

    const fullMessage = `${bugText}\n\n---\nDiagnostic Info:\nStreaming Service: Netflix\nMovie Title: ${movieTitle || 'Unknown'}\nCurrent Time: ${formattedTime}${timestampsInfo}`;

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
  }, [settings.enabled, settings.mute, settings.warn, settings.blur, settings.skip, expandedControl]);

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
      setMovieJumpscares(response.jumpscareTimes || []);
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
        src={settingsIcon}
        className="gear-icon" 
        onClick={() => { setShowSettings(true); setExpandedControl(null); }}
        alt="Settings"
      />
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
          <div className={`expand-arrow ${expandedControl === 'mute' ? 'is-expanded' : ''}`} onClick={() => toggleExpand('mute')}>
            <svg width="14" height="8" viewBox="0 0 14 8" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L7 7L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
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
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'space-between' }}>
            <div className="sub-control" style={{ flex: 1 }}>
              <label htmlFor="muteMajor">Major</label>
              <div className="toggle scale-down">
                <input type="checkbox" id="muteMajor" checked={settings.muteMajor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('muteMajor', !settings.muteMajor)} />
                <span className="slider" />
              </div>
            </div>
            <div className="sub-control" style={{ flex: 1 }}>
              <label htmlFor="muteMinor">Minor</label>
              <div className="toggle scale-down">
                <input type="checkbox" id="muteMinor" checked={settings.muteMinor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('muteMinor', !settings.muteMinor)} />
                <span className="slider" />
              </div>
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
          <div className={`expand-arrow ${expandedControl === 'blur' ? 'is-expanded' : ''}`} onClick={() => toggleExpand('blur')}>
            <svg width="14" height="8" viewBox="0 0 14 8" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L7 7L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
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
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'space-between' }}>
            <div className="sub-control" style={{ flex: 1 }}>
              <label htmlFor="blurMajor">Major</label>
              <div className="toggle scale-down">
                <input type="checkbox" id="blurMajor" checked={settings.blurMajor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('blurMajor', !settings.blurMajor)} />
                <span className="slider" />
              </div>
            </div>
            <div className="sub-control" style={{ flex: 1 }}>
              <label htmlFor="blurMinor">Minor</label>
              <div className="toggle scale-down">
                <input type="checkbox" id="blurMinor" checked={settings.blurMinor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('blurMinor', !settings.blurMinor)} />
                <span className="slider" />
              </div>
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
          <div className={`expand-arrow ${expandedControl === 'warn' ? 'is-expanded' : ''}`} onClick={() => toggleExpand('warn')}>
            <svg width="14" height="8" viewBox="0 0 14 8" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L7 7L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
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
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'space-between' }}>
            <div className="sub-control" style={{ flex: 1 }}>
              <label htmlFor="warnMajor">Major</label>
              <div className="toggle scale-down">
                <input type="checkbox" id="warnMajor" checked={settings.warnMajor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('warnMajor', !settings.warnMajor)} />
                <span className="slider" />
              </div>
            </div>
            <div className="sub-control" style={{ flex: 1 }}>
              <label htmlFor="warnMinor">Minor</label>
              <div className="toggle scale-down">
                <input type="checkbox" id="warnMinor" checked={settings.warnMinor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('warnMinor', !settings.warnMinor)} />
                <span className="slider" />
              </div>
            </div>
          </div>
          <div className="sub-control" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px', paddingTop: '12px', marginTop: '4px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
            <label htmlFor="timer" style={{ alignSelf: 'flex-start' }}>TIMER (SEC)</label>
            <div className={`range-container ${!settings.warn ? 'is-disabled' : ''}`}>
              <input
                ref={rangeRef}
                type="range"
                id="timer"
                min={MIN_TIMER}
                max={MAX_TIMER}
                value={settings.timer}
                disabled={!settings.warn}
                onChange={event => updateSetting('timer', Number(event.target.value))}
              />
              <div
                className={`range-value ${!settings.warn ? 'is-disabled' : ''}`}
                style={{ left: `${sliderLeft}px` }}
              >
                {settings.timer}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`control-wrapper ${expandedControl === 'skip' ? 'is-expanded' : ''} ${areFeatureTogglesDisabled ? 'is-disabled' : ''}`}>
        <div className="main-control">
          <label 
            onClick={() => toggleExpand('skip')} 
            className={`feature-label ${expandedControl === 'skip' ? 'blood-fill' : ''}`}
          >
            SKIP
          </label>
          <div className={`expand-arrow ${expandedControl === 'skip' ? 'is-expanded' : ''}`} onClick={() => toggleExpand('skip')}>
            <svg width="14" height="8" viewBox="0 0 14 8" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L7 7L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="toggle">
            <input
              type="checkbox"
              id="skip"
              checked={settings.skip}
              disabled={areFeatureTogglesDisabled}
              onChange={() => updateFeatureToggle('skip', !settings.skip)}
            />
            <span className="slider" />
          </div>
        </div>
        <div className="sub-controls">
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'space-between' }}>
            <div className="sub-control" style={{ flex: 1 }}>
              <label htmlFor="skipMajor">Major</label>
              <div className="toggle scale-down">
                <input type="checkbox" id="skipMajor" checked={settings.skipMajor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('skipMajor', !settings.skipMajor)} />
                <span className="slider" />
              </div>
            </div>
            <div className="sub-control" style={{ flex: 1 }}>
              <label htmlFor="skipMinor">Minor</label>
              <div className="toggle scale-down">
                <input type="checkbox" id="skipMinor" checked={settings.skipMinor} disabled={areFeatureTogglesDisabled} onChange={() => updateSetting('skipMinor', !settings.skipMinor)} />
                <span className="slider" />
              </div>
            </div>
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
          <details className="bug-report-timestamps-details" style={{ marginTop: '8px', marginBottom: '16px' }}>
            <summary style={{ cursor: 'pointer', fontFamily: 'var(--font-scary)', fontSize: '1.2rem', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', listStyle: 'none' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <svg className="timestamps-expand-icon" width="14" height="8" viewBox="0 0 14 8" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transition: 'transform 0.3s ease' }}>
                  <path d="M1 1L7 7L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Timestamps
              </span>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const titleKey = movieTitle || 'Unknown';
                  const custom = customJumpscares[titleKey];
                  if (custom && custom.scares) {
                    const importedMods = {};
                    custom.scares.forEach((scare, idx) => {
                      importedMods[idx] = { time: scare.time, severity: scare.severity, removed: false };
                    });
                    const updated = {
                      ...modifiedTimestamps,
                      [titleKey]: importedMods
                    };
                    setModifiedTimestamps(updated);
                    chrome.storage.local.set({ bugReportTimestamps: updated });
                  }
                }}
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '4px', padding: '2px 8px', fontSize: '0.9rem', cursor: 'pointer', fontFamily: 'var(--font-scary)' }}
                title="Import from SET JUMPSCARES"
              >
                IMPORT
              </button>
            </summary>
            <div style={{ maxHeight: '150px', overflowY: 'auto', marginTop: '8px', padding: '8px', background: 'var(--surface)', borderRadius: '4px' }}>
              {(() => {
                const userMods = modifiedTimestamps[movieTitle || 'Unknown'] || {};
                const maxIdx = Math.max((movieJumpscares?.length || 0) - 1, ...Object.keys(userMods).map(Number));
                const totalItems = maxIdx >= 0 ? maxIdx + 1 : 0;
                return Array.from({ length: totalItems }).map((_, idx) => {
                  const js = movieJumpscares[idx] || { time: 0, severity: 'Minor' };
                  const mod = userMods[idx];
                  const currentMod = typeof mod === 'object' ? mod : (mod !== undefined ? { time: mod } : {});
                
                const currentSeverity = currentMod.severity !== undefined ? currentMod.severity : js.severity;
                const currentTimeVal = currentMod.time !== undefined ? currentMod.time : formatSecondsToTime(js.time);
                const isRemoved = currentMod.removed || false;
                
                return (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', opacity: isRemoved ? 0.5 : 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <select 
                        value={currentSeverity} 
                        onChange={(e) => handleScareEdit(idx, 'severity', e.target.value)}
                        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '4px', padding: '2px' }}
                        disabled={isRemoved}
                      >
                        <option value="Minor" style={{ color: '#000' }}>Minor</option>
                        <option value="Major" style={{ color: '#000' }}>Major</option>
                      </select>
                      <input 
                        type="text" 
                        style={{ width: '60px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', padding: '2px 4px', borderRadius: '4px' }}
                        value={currentTimeVal} 
                        onChange={(e) => handleScareEdit(idx, 'time', e.target.value)}
                        disabled={isRemoved}
                      />
                      <button
                        onClick={() => handleScareEdit(idx, 'time', formatSecondsToTime(currentTime))}
                        disabled={isRemoved || currentTime === null}
                        style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '4px', padding: '2px 4px', cursor: (isRemoved || currentTime === null) ? 'default' : 'pointer', fontSize: '0.8rem', fontFamily: 'var(--font-main)' }}
                        title="Set to current playback time"
                      >
                        Now
                      </button>
                    </div>
                    <button 
                      onClick={() => handleScareEdit(idx, 'removed', !isRemoved)}
                      style={{ background: isRemoved ? 'var(--accent)' : 'transparent', border: '1px solid var(--accent)', color: isRemoved ? '#fff' : 'var(--accent)', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '0.9rem' }}
                    >
                      {isRemoved ? 'Undo' : 'X'}
                    </button>
                  </div>
                );
              });
            })()}
              {(!movieJumpscares || movieJumpscares.length === 0) && Object.keys(modifiedTimestamps[movieTitle || 'Unknown'] || {}).length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No jumpscares loaded.</div>
              )}
            </div>
          </details>
          <div className="bug-report-actions">
            <button className="bug-report-btn cancel" onClick={() => { setShowBugReport(false); setBugText(""); }} disabled={isSending}>Cancel</button>
            <button className="bug-report-btn send" onClick={handleSendBug} disabled={isSending || !bugText.trim()}>
              {isSending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </div>
      )}
      {showSettings && (
        <div className="bug-report-overlay">
          <h2 className="bug-report-title">Settings</h2>
          <div style={{ padding: '16px 0' }}>
            <div className={`control-wrapper ${expandedControl === 'adjust' ? 'is-expanded' : ''} ${areFeatureTogglesDisabled ? 'is-disabled' : ''}`}>
              <div className="main-control" style={{ cursor: 'pointer' }} onClick={() => toggleExpand('adjust')}>
                <label className={`feature-label ${expandedControl === 'adjust' ? 'blood-fill' : ''}`} style={{ cursor: 'pointer' }}>
                  ADJUST
                </label>
                <div className={`expand-arrow ${expandedControl === 'adjust' ? 'is-expanded' : ''}`}>
                  <svg width="14" height="8" viewBox="0 0 14 8" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 1L7 7L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>
              <div className="sub-controls" style={{ flexDirection: 'column', gap: '16px', padding: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label>DELAY (SEC)</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button 
                      onClick={() => {
                        if (!movieTitle) return;
                        const currentOffset = settings.movieOffsets?.[movieTitle] || 0;
                        updateSetting('movieOffsets', { ...settings.movieOffsets, [movieTitle]: Math.max(-300, currentOffset - 1) });
                      }}
                      disabled={isTimerDisabled || !movieTitle}
                      style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '50%', width: '28px', height: '28px', cursor: (isTimerDisabled || !movieTitle) ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                    >
                      -
                    </button>
                    <span style={{ fontFamily: 'var(--font-scary)', fontSize: '1.4rem', color: 'var(--text)', minWidth: '40px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                      {movieTitle && (settings.movieOffsets?.[movieTitle] || 0) > 0 ? `+${settings.movieOffsets[movieTitle]}` : (movieTitle ? (settings.movieOffsets?.[movieTitle] || 0) : 0)}
                    </span>
                    <button 
                      onClick={() => {
                        if (!movieTitle) return;
                        const currentOffset = settings.movieOffsets?.[movieTitle] || 0;
                        updateSetting('movieOffsets', { ...settings.movieOffsets, [movieTitle]: Math.min(300, currentOffset + 1) });
                      }}
                      disabled={isTimerDisabled || !movieTitle}
                      style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '50%', width: '28px', height: '28px', cursor: (isTimerDisabled || !movieTitle) ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label>NEXT SCARE</label>
                  <span style={{ fontFamily: 'var(--font-scary)', fontSize: '1.4rem', color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
                    {secondsToNextScare != null ? `${secondsToNextScare}s` : '--'}
                  </span>
                </div>
              </div>
            </div>
            
            <div className={`control-wrapper ${expandedControl === 'setjumpscares' ? 'is-expanded' : ''} ${areFeatureTogglesDisabled ? 'is-disabled' : ''}`} style={{ marginTop: '8px' }}>
              <div className="main-control" style={{ cursor: currentTitleConfig.useCustom ? 'pointer' : 'default' }} onClick={() => currentTitleConfig.useCustom && toggleExpand('setjumpscares')}>
                <label className={`feature-label ${expandedControl === 'setjumpscares' ? 'blood-fill' : ''}`} style={{ cursor: currentTitleConfig.useCustom ? 'pointer' : 'default' }}>
                  SET JUMPSCARES
                </label>
                <div style={{ display: 'flex', alignItems: 'center', zIndex: 10 }}>
                  <label className="toggle" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={currentTitleConfig.useCustom}
                      onChange={handleCustomToggle}
                      disabled={!movieTitle}
                    />
                    <span className="slider"></span>
                  </label>
                </div>
                <div className={`expand-arrow ${expandedControl === 'setjumpscares' ? 'is-expanded' : ''}`} style={{ opacity: currentTitleConfig.useCustom ? 1 : 0.3 }}>
                  <svg width="14" height="8" viewBox="0 0 14 8" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 1L7 7L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>
              <div className="sub-controls" style={{ flexDirection: 'column', gap: '16px', padding: '16px' }}>
                <div style={{ maxHeight: '200px', overflowY: 'auto', background: 'var(--surface)', borderRadius: '4px', padding: '8px', marginTop: '8px' }}>
                  {currentTitleConfig.scares.map((js, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <select 
                            value={js.severity} 
                            onChange={(e) => updateCustomScare(idx, 'severity', e.target.value)}
                            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '4px', padding: '2px' }}
                          >
                            <option value="Minor" style={{ color: '#000' }}>Minor</option>
                            <option value="Major" style={{ color: '#000' }}>Major</option>
                          </select>
                          <input 
                            type="text" 
                            style={{ width: '60px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', padding: '2px 4px', borderRadius: '4px' }}
                            value={js.time} 
                            onChange={(e) => updateCustomScare(idx, 'time', e.target.value)}
                            placeholder="MM:SS"
                          />
                          <button
                            onClick={() => updateCustomScare(idx, 'time', formatSecondsToTime(currentTime))}
                            disabled={currentTime === null}
                            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '4px', padding: '2px 4px', cursor: currentTime === null ? 'default' : 'pointer', fontSize: '0.8rem', fontFamily: 'var(--font-main)' }}
                            title="Set to current playback time"
                          >
                            Now
                          </button>
                        </div>
                        <button 
                          onClick={() => removeCustomScare(idx)}
                          style={{ background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '0.9rem' }}
                        >
                          X
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={addCustomScare}
                      style={{ width: '100%', background: 'transparent', border: '1px dashed var(--text-muted)', color: 'var(--text)', padding: '8px', cursor: 'pointer', borderRadius: '4px', marginTop: '8px', fontFamily: 'var(--font-scary)' }}
                    >
                      + ADD NEW JUMPSCARE
                    </button>
                  </div>
              </div>
            </div>
          </div>
          <div className="bug-report-actions">
            <button className="bug-report-btn cancel" onClick={() => setShowSettings(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
