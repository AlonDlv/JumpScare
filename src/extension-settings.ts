export const MIN_TIMER = 3;
export const MAX_TIMER = 10;

export type ExtensionSettings = {
  enabled: boolean;
  warn: boolean;
  warnMajor: boolean;
  warnMinor: boolean;
  mute: boolean;
  muteMajor: boolean;
  muteMinor: boolean;
  blur: boolean;
  blurMajor: boolean;
  blurMinor: boolean;
  timer: number;
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  warn: false,
  warnMajor: true,
  warnMinor: true,
  mute: false,
  muteMajor: true,
  muteMinor: true,
  blur: false,
  blurMajor: true,
  blurMinor: true,
  timer: MIN_TIMER
};

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<
  keyof ExtensionSettings
>;

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

function normalizeTimer(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return DEFAULT_SETTINGS.timer;
  }

  return Math.min(MAX_TIMER, Math.max(MIN_TIMER, numericValue));
}

function normalizeEnabled(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_SETTINGS.enabled;
}

function normalizeSettings(
  settings: Partial<ExtensionSettings> | null | undefined
): ExtensionSettings {
  return {
    enabled: normalizeEnabled(settings?.enabled),
    warn: Boolean(settings?.warn),
    warnMajor: typeof settings?.warnMajor === "boolean" ? settings.warnMajor : DEFAULT_SETTINGS.warnMajor,
    warnMinor: typeof settings?.warnMinor === "boolean" ? settings.warnMinor : DEFAULT_SETTINGS.warnMinor,
    mute: Boolean(settings?.mute),
    muteMajor: typeof settings?.muteMajor === "boolean" ? settings.muteMajor : DEFAULT_SETTINGS.muteMajor,
    muteMinor: typeof settings?.muteMinor === "boolean" ? settings.muteMinor : DEFAULT_SETTINGS.muteMinor,
    blur: Boolean(settings?.blur),
    blurMajor: typeof settings?.blurMajor === "boolean" ? settings.blurMajor : DEFAULT_SETTINGS.blurMajor,
    blurMinor: typeof settings?.blurMinor === "boolean" ? settings.blurMinor : DEFAULT_SETTINGS.blurMinor,
    timer: normalizeTimer(settings?.timer)
  };
}

function readLocalFallback(): ExtensionSettings {
  return normalizeSettings({
    enabled: JSON.parse(localStorage.getItem("enabled") ?? "true"),
    warn: JSON.parse(localStorage.getItem("warn") ?? "false"),
    warnMajor: JSON.parse(localStorage.getItem("warnMajor") ?? "true"),
    warnMinor: JSON.parse(localStorage.getItem("warnMinor") ?? "true"),
    mute: JSON.parse(localStorage.getItem("mute") ?? "false"),
    muteMajor: JSON.parse(localStorage.getItem("muteMajor") ?? "true"),
    muteMinor: JSON.parse(localStorage.getItem("muteMinor") ?? "true"),
    blur: JSON.parse(localStorage.getItem("blur") ?? "false"),
    blurMajor: JSON.parse(localStorage.getItem("blurMajor") ?? "true"),
    blurMinor: JSON.parse(localStorage.getItem("blurMinor") ?? "true"),
    timer: localStorage.getItem("timer")
  });
}

function writeLocalFallback(settings: ExtensionSettings): void {
  localStorage.setItem("enabled", JSON.stringify(settings.enabled));
  localStorage.setItem("warn", JSON.stringify(settings.warn));
  localStorage.setItem("warnMajor", JSON.stringify(settings.warnMajor));
  localStorage.setItem("warnMinor", JSON.stringify(settings.warnMinor));
  localStorage.setItem("mute", JSON.stringify(settings.mute));
  localStorage.setItem("muteMajor", JSON.stringify(settings.muteMajor));
  localStorage.setItem("muteMinor", JSON.stringify(settings.muteMinor));
  localStorage.setItem("blur", JSON.stringify(settings.blur));
  localStorage.setItem("blurMajor", JSON.stringify(settings.blurMajor));
  localStorage.setItem("blurMinor", JSON.stringify(settings.blurMinor));
  localStorage.setItem("timer", settings.timer.toString());
}

export function loadSettings(): Promise<ExtensionSettings> {
  if (!hasChromeStorage()) {
    return Promise.resolve(readLocalFallback());
  }

  return new Promise(resolve => {
    chrome.storage.local.get(DEFAULT_SETTINGS, items => {
      const settings = normalizeSettings(items as Partial<ExtensionSettings>);
      writeLocalFallback(settings);
      resolve(settings);
    });
  });
}

export async function saveSettings(
  partialSettings: Partial<ExtensionSettings>
): Promise<ExtensionSettings> {
  const currentSettings = await loadSettings();
  const nextSettings = normalizeSettings({
    ...currentSettings,
    ...partialSettings
  });

  writeLocalFallback(nextSettings);

  if (!hasChromeStorage()) {
    return nextSettings;
  }

  return new Promise(resolve => {
    chrome.storage.local.set(nextSettings, () => {
      resolve(nextSettings);
    });
  });
}

export function subscribeToSettings(
  listener: (settings: ExtensionSettings) => void
): () => void {
  if (!hasChromeStorage()) {
    return () => {};
  }

  const handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName !== "local") {
      return;
    }

    const relevantChange = SETTINGS_KEYS.some(key => key in changes);
    if (!relevantChange) {
      return;
    }

    void loadSettings().then(listener);
  };

  chrome.storage.onChanged.addListener(handleStorageChange);

  return () => {
    chrome.storage.onChanged.removeListener(handleStorageChange);
  };
}
