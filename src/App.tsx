import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, TouchEvent } from 'react';
import type { DirectionTraffic, TrafficData, TrafficDetails, TrafficError } from './types';

const REFRESH_INTERVAL_MS = 4 * 60 * 1000;
const PULL_REFRESH_THRESHOLD = 58;
const MAX_PULL_DISTANCE = 90;
const API_KEY_STORAGE_KEY = 'opentransportdata_api_key';
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

type Severity = 'clear' | 'traffic' | 'moderate' | 'heavy';

function severityFor(queueKm: number): { key: Severity; label: string } {
  if (queueKm <= 0) return { key: 'clear', label: 'No queue' };
  if (queueKm < 2) return { key: 'traffic', label: 'Traffic' };
  if (queueKm < 6) return { key: 'moderate', label: 'Moderate queue' };
  return { key: 'heavy', label: 'Heavy queue' };
}

function formatQueue(queueKm: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(queueKm)} km`;
}

function formatWaiting(minutes: number | null): string {
  if (minutes === null) return 'Waiting time not available';
  if (minutes <= 0) return 'No additional wait';
  if (minutes < 60) return `About ${minutes} min wait`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `About ${hours} hr${remainder ? ` ${remainder} min` : ''} wait`;
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
    timeZoneName: 'short',
  }).format(date);
}

function formatDetailDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function TrafficDetailsPanel({
  direction,
  destination,
  details,
}: {
  direction: string;
  destination: string;
  details: TrafficDetails | null;
}) {
  return (
    <article className="direction-details">
      <header className="details-heading">
        <div>
          <p className="eyebrow">{direction}</p>
          <h3>{destination}</h3>
        </div>
      </header>
      {!details ? (
        <p className="no-details">No active traffic notices.</p>
      ) : (
        <div className="details-content">
          <dl>
          {details.eventType && <><dt>Situation</dt><dd>{details.eventType}</dd></>}
          {details.cause && <><dt>Cause</dt><dd>{details.cause}</dd></>}
          {details.lanesRestricted !== null && (
            <><dt>Restricted lanes</dt><dd>{details.lanesRestricted}</dd></>
          )}
          {details.validFrom && <><dt>Since</dt><dd>{formatDetailDate(details.validFrom)}</dd></>}
          {(details.untilFurtherNotice || details.validUntil) && (
            <>
              <dt>Expected until</dt>
              <dd>{details.untilFurtherNotice ? 'Further notice' : formatDetailDate(details.validUntil!)}</dd>
            </>
          )}
          </dl>
          {details.officialMessage && (
            <details className="official-message">
              <summary>Official ASTRA notice</summary>
              <p>{details.officialMessage}</p>
            </details>
          )}
        </div>
      )}
    </article>
  );
}

function DirectionCard({
  direction,
  destination,
  data,
}: {
  direction: string;
  destination: string;
  data: DirectionTraffic;
}) {
  const severity = severityFor(data.queueKm);
  return (
    <article className={`traffic-card traffic-card--${severity.key}`}>
      <div className="card-topline">
        <div>
          <p className="eyebrow">{direction}</p>
          <h2>{destination}</h2>
        </div>
        <span className="direction-arrow" aria-hidden="true">↓</span>
      </div>
      <div className="queue-value">{formatQueue(data.queueKm)}</div>
      <p className="waiting-time">{formatWaiting(data.waitingMinutes)}</p>
      <div className="status-row">
        <span className="status-dot" aria-hidden="true" />
        <span>{severity.label}</span>
      </div>
    </article>
  );
}

function ApiKeyDialog({
  initialValue,
  canClose,
  onClose,
  onSave,
}: {
  initialValue: string;
  canClose: boolean;
  onClose: () => void;
  onSave: (apiKey: string) => void;
}) {
  const [value, setValue] = useState(initialValue);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const apiKey = value.trim().replace(/^Bearer\s+/i, '');
    if (apiKey) onSave(apiKey);
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (canClose && event.target === event.currentTarget) onClose();
      }}
    >
      <section className="api-dialog" role="dialog" aria-modal="true" aria-labelledby="api-key-title">
        {canClose && (
          <button className="dialog-close" type="button" onClick={onClose} aria-label="Close API key dialog">×</button>
        )}
        <div className="key-icon" aria-hidden="true">⌁</div>
        <p className="eyebrow">Connection required</p>
        <h2 id="api-key-title">Enter your API key</h2>
        <p className="dialog-copy">
          No server key is configured. Your key is sent only to this app's proxy and kept for this browser tab.
        </p>
        <div className="key-help">
          <strong>Request the correct API token</strong>
          <ol>
            <li>
              Open{' '}
              <a
                href="https://api-manager.opentransportdata.swiss/portal/catalogue-products/tedp_road_traffic_traffic_situations_policy-1"
                target="_blank"
                rel="noreferrer"
              >
                Road traffic - traffic situations
              </a>
              .
            </li>
            <li>Select the <strong>Traffic situations</strong> plan and choose <strong>Access with this plan</strong>.</li>
            <li>Sign in, select or create an app, then copy the <strong>TOKEN</strong>—not the Token Hash.</li>
          </ol>
        </div>
        <form onSubmit={handleSubmit}>
          <label htmlFor="api-key">Open Transport Data API key</label>
          <input
            id="api-key"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste your bearer token"
            autoComplete="off"
            autoFocus
            required
          />
          <button className="save-key-button" type="submit">Save and load traffic</button>
        </form>
      </section>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<TrafficData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem(API_KEY_STORAGE_KEY) ?? '');
  const [hasServerApiKey, setHasServerApiKey] = useState<boolean | null>(null);
  const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const touchStartY = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);

  const loadTraffic = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const response = await fetch(apiUrl('/api/traffic'), {
        headers: !hasServerApiKey && apiKey
          ? { 'X-OpenTransportData-Api-Key': apiKey }
          : undefined,
      });
      const body = (await response.json()) as TrafficData | TrafficError;
      if (!response.ok) {
        const failure = body as TrafficError;
        if (failure.staleData) {
          setData(failure.staleData);
          setIsStale(true);
        }
        if (failure.code === 'api_key_required' || failure.code === 'invalid_api_key') {
          setShowApiKeyDialog(true);
        }
        throw new Error(failure.error || 'Traffic data is unavailable.');
      }
      setData(body as TrafficData);
      setError(null);
      setIsStale(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Traffic data is unavailable.');
    } finally {
      setIsRefreshing(false);
    }
  }, [apiKey, hasServerApiKey]);

  useEffect(() => {
    fetch(apiUrl('/api/config'))
      .then((response) => response.json() as Promise<{ hasServerApiKey: boolean }>)
      .then((config) => {
        setHasServerApiKey(config.hasServerApiKey);
        if (!config.hasServerApiKey && !apiKey) setShowApiKeyDialog(true);
      })
      .catch(() => setHasServerApiKey(false));
  }, [apiKey]);

  useEffect(() => {
    if (hasServerApiKey === null || (!hasServerApiKey && !apiKey)) {
      setIsRefreshing(false);
      return;
    }

    void loadTraffic();
    const refreshTimer = window.setInterval(() => void loadTraffic(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(refreshTimer);
  }, [apiKey, hasServerApiKey, loadTraffic]);

  function saveApiKey(nextApiKey: string) {
    sessionStorage.setItem(API_KEY_STORAGE_KEY, nextApiKey);
    setApiKey(nextApiKey);
    setError(null);
    setShowApiKeyDialog(false);
  }

  function forgetApiKey() {
    sessionStorage.removeItem(API_KEY_STORAGE_KEY);
    setApiKey('');
    setShowApiKeyDialog(true);
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    if (!data || isRefreshing) return;
    const detailsPanel = (event.target as Element).closest('.additional-info');
    const detailsAtTop = !detailsPanel || detailsPanel.scrollTop <= 0;
    if (event.currentTarget.scrollTop <= 0 && detailsAtTop) {
      touchStartY.current = event.touches[0].clientY;
    }
  }

  function handleTouchMove(event: TouchEvent<HTMLElement>) {
    if (touchStartY.current === null) return;
    const distance = event.touches[0].clientY - touchStartY.current;
    if (distance <= 0) {
      pullDistanceRef.current = 0;
      setPullDistance(0);
      return;
    }
    if (event.cancelable) event.preventDefault();
    const resistedDistance = Math.min(distance * 0.45, MAX_PULL_DISTANCE);
    pullDistanceRef.current = resistedDistance;
    setPullDistance(resistedDistance);
  }

  function finishPull() {
    const shouldRefresh = pullDistanceRef.current >= PULL_REFRESH_THRESHOLD;
    touchStartY.current = null;
    pullDistanceRef.current = 0;
    setPullDistance(0);
    if (shouldRefresh && !isRefreshing) void loadTraffic();
  }

  return (
    <main
      className="app-shell"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={finishPull}
      onTouchCancel={finishPull}
    >
      <div
        className={`pull-indicator${pullDistance > 0 ? ' pull-indicator--visible' : ''}`}
        style={{
          opacity: Math.min(pullDistance / 24, 1),
          transform: `translate(-50%, ${Math.min(pullDistance, 64)}px)`,
        }}
        aria-hidden="true"
      >
        <span>{pullDistance >= PULL_REFRESH_THRESHOLD ? 'Release to refresh' : 'Pull to refresh'}</span>
      </div>

      <header className="site-header">
        <div className="header-identity">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <p className="site-kicker">Gotthard · A2 road tunnel</p>
            <h1>Ghottacci</h1>
          </div>
        </div>
        <div className="header-update">
          <p className="eyebrow">Last update</p>
          <p>{data ? formatUpdated(data.updatedAt) : '—'}</p>
        </div>
      </header>

      {error && (
        <div className="notice" role="status">
          <span>{isStale ? 'Showing the last available update.' : error}</span>
          <button type="button" onClick={() => void loadTraffic()}>Try again</button>
        </div>
      )}

      {!data ? (
        <section className="loading-state" aria-live="polite">
          <span className="loader" aria-hidden="true" />
          <p>{isRefreshing ? 'Checking the tunnel…' : 'Live data unavailable'}</p>
        </section>
      ) : (
        <div className="traffic-content">
          <section className="cards" aria-label="Current tunnel queues">
            <DirectionCard direction="Southbound" destination="Italy" data={data.southbound} />
            <DirectionCard direction="Northbound" destination="Germany" data={data.northbound} />
          </section>
          <section className="additional-info" aria-labelledby="additional-info-title">
            <div className="additional-info-heading">
              <p className="eyebrow">Live road notices</p>
              <h2 id="additional-info-title">Additional information</h2>
            </div>
            <div className="direction-details-list">
              <TrafficDetailsPanel direction="Southbound" destination="Italy" details={data.southbound.details} />
              <TrafficDetailsPanel direction="Northbound" destination="Germany" details={data.northbound.details} />
            </div>
            <footer className="panel-footer">
              <p className="source-note">Live data from ASTRA / opentransportdata.swiss</p>
              {hasServerApiKey === false && (
                <div className="key-actions">
                  <button type="button" onClick={() => setShowApiKeyDialog(true)}>
                    {apiKey ? 'Change API key' : 'Add API key'}
                  </button>
                  {apiKey && <button type="button" onClick={forgetApiKey}>Forget key</button>}
                </div>
              )}
            </footer>
          </section>
        </div>
      )}

      {data && isRefreshing && (
        <div className="refresh-overlay" role="status" aria-live="polite">
          <div className="refresh-overlay-card">
            <span className="loader" aria-hidden="true" />
            <span>Updating traffic…</span>
          </div>
        </div>
      )}

      {showApiKeyDialog && (
        <ApiKeyDialog
          initialValue={apiKey}
          canClose={Boolean(data)}
          onClose={() => setShowApiKeyDialog(false)}
          onSave={saveApiKey}
        />
      )}
    </main>
  );
}
