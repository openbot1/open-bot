import { useCallback, useEffect, useState } from 'react';
import type {
  BotConfigLike,
  FleetStatusView,
  MarketplaceCollectionView,
  MarketplaceEntryVersionView,
  MarketplaceV2EntryView,
} from '../types';
import { useT } from '../i18n/useT';

/**
 * Bot marketplace v2 — searchable catalog of bot templates and locally
 * published bots, with ratings and one-click install.
 *
 * Data flows over IPC `marketplace-v2:*` (see main.ts): the catalog is
 * built on this machine from the 20 built-in templates plus the local
 * published store — no central server, no network. Search, sort and
 * ratings run in core (packages/core/src/agent/marketplaceV2.ts).
 * Installing returns a fresh BotConfig, which the parent saves as a
 * bot via onBotInstalled.
 */

/** Call a window.openBot method by IPC channel, falling back to camelCase. */
async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

function categoryLabel(t: (key: string, vars?: Record<string, string | number>) => string, category: string): string {
  if (category === 'code') return t('marketplace.category.code');
  if (category === 'research') return t('marketplace.category.research');
  if (category === 'writing') return t('marketplace.category.writing');
  if (category === 'data') return t('marketplace.category.data');
  if (category === 'automation') return t('marketplace.category.automation');
  if (category === 'general') return t('marketplace.category.general');
  return category;
}

type Sort = 'rating' | 'installs' | 'name' | 'newest';

interface Props {
  onBack: () => void;
  onBotInstalled: (bot: BotConfigLike) => void;
}

export default function BotMarketplaceView({ onBack, onBotInstalled }: Props) {
  const t = useT();
  const [entries, setEntries] = useState<MarketplaceV2EntryView[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<Sort>('rating');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [ratingId, setRatingId] = useState<string | null>(null);
  // v1.03 (Team T6): collections, version history, install to a fleet workspace.
  const [collections, setCollections] = useState<MarketplaceCollectionView[]>([]);
  const [workspaces, setWorkspaces] = useState<FleetStatusView[]>([]);
  const [installWorkspaceId, setInstallWorkspaceId] = useState('');
  const [versionsByEntry, setVersionsByEntry] = useState<Record<string, MarketplaceEntryVersionView[]>>({});
  const [expandedVersionsId, setExpandedVersionsId] = useState<string | null>(null);
  const [installingCollectionId, setInstallingCollectionId] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    try {
      const [catalog, cols, fleet] = await Promise.all([
        callOpenBot<MarketplaceV2EntryView[]>('marketplace-v2:catalog', 'listMarketplaceV2'),
        callOpenBot<MarketplaceCollectionView[]>('marketplace-v3:collections', 'listMarketplaceCollections'),
        callOpenBot<FleetStatusView[]>('fleet:list', 'listFleet'),
      ]);
      if (catalog) {
        setCategories([...new Set(catalog.map((e) => e.category))].sort());
      }
      if (cols) setCollections(cols);
      if (fleet) {
        setWorkspaces(fleet);
        if (!installWorkspaceId && fleet.length > 0) setInstallWorkspaceId(fleet[0].workspace.id);
      }
    } catch {
      // Categories are best-effort; search still works without them.
    }
  }, [installWorkspaceId]);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await callOpenBot<MarketplaceV2EntryView[]>(
        'marketplace-v2:search',
        'searchMarketplaceV2',
        { query, category: category || undefined, sort },
      );
      if (!results) {
        setError(t('marketplace.loadError'));
        return;
      }
      setEntries(results);
    } catch (err) {
      setError((err as Error).message || t('marketplace.loadError'));
    } finally {
      setLoading(false);
    }
  }, [query, category, sort, t]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    void search();
  }, [search]);

  async function handleInstall(entry: MarketplaceV2EntryView) {
    setActionError(null);
    setNotice(null);
    setInstallingId(entry.id);
    try {
      const bot = await callOpenBot<BotConfigLike>('marketplace-v2:install', 'installMarketplaceV2', entry.id);
      if (!bot) throw new Error(t('botMarketplace.installError'));
      setNotice(t('marketplace.installedOk', { name: entry.name }));
      onBotInstalled(bot);
      await search();
    } catch (err) {
      setActionError((err as Error).message || t('botMarketplace.installError'));
    } finally {
      setInstallingId(null);
    }
  }

  async function handleRate(entry: MarketplaceV2EntryView, stars: number) {
    setActionError(null);
    setNotice(null);
    setRatingId(entry.id);
    try {
      const summary = await callOpenBot<{ average: number; count: number }>(
        'marketplace-v2:rate',
        'rateMarketplaceV2',
        entry.id,
        stars,
      );
      if (!summary) throw new Error(t('botMarketplace.installError'));
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id ? { ...e, ratingAverage: summary.average, ratingCount: summary.count } : e,
        ),
      );
      setNotice(t('botMarketplace.rateSaved'));
    } catch (err) {
      setActionError((err as Error).message || t('botMarketplace.installError'));
    } finally {
      setRatingId(null);
    }
  }

  async function handleToggleVersions(entry: MarketplaceV2EntryView) {
    if (expandedVersionsId === entry.id) {
      setExpandedVersionsId(null);
      return;
    }
    setExpandedVersionsId(entry.id);
    if (versionsByEntry[entry.id]) return;
    try {
      const versions = await callOpenBot<MarketplaceEntryVersionView[]>(
        'marketplace-v3:versions',
        'listMarketplaceEntryVersions',
        entry.id,
      );
      if (versions) setVersionsByEntry((prev) => ({ ...prev, [entry.id]: versions }));
    } catch {
      setVersionsByEntry((prev) => ({ ...prev, [entry.id]: [] }));
    }
  }

  async function handleInstallToWorkspace(entry: MarketplaceV2EntryView) {
    if (!installWorkspaceId) return;
    setActionError(null);
    setNotice(null);
    setInstallingId(entry.id);
    try {
      const result = await callOpenBot<{ config: BotConfigLike }>(
        'marketplace-v3:install-to-workspace',
        'installMarketplaceToWorkspace',
        { entryId: entry.id, workspaceId: installWorkspaceId },
      );
      if (!result) throw new Error(t('botMarketplace.installError'));
      setNotice(t('marketplace.installedOk', { name: entry.name }));
      onBotInstalled(result.config);
      await search();
    } catch (err) {
      setActionError((err as Error).message || t('botMarketplace.installError'));
    } finally {
      setInstallingId(null);
    }
  }

  async function handleInstallCollection(collection: MarketplaceCollectionView) {
    setActionError(null);
    setNotice(null);
    setInstallingCollectionId(collection.id);
    try {
      let installed = 0;
      for (const entryId of collection.entryIds) {
        const bot = await callOpenBot<BotConfigLike>('marketplace-v2:install', 'installMarketplaceV2', entryId);
        if (bot) {
          installed += 1;
          onBotInstalled(bot);
        }
      }
      setNotice(t('botMarketplace.collectionInstalled', { name: collection.name, count: installed }));
      await search();
    } catch (err) {
      setActionError((err as Error).message || t('botMarketplace.installError'));
    } finally {
      setInstallingCollectionId(null);
    }
  }

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <button className="btn secondary" onClick={onBack}>
          {t('marketplace.back')}
        </button>
        <h2 style={{ margin: 0, flex: 1 }}>{t('botMarketplace.title')}</h2>
        <button className="btn secondary" onClick={() => void search()} disabled={loading}>
          {t('fleet.refresh')}
        </button>
      </div>
      <p style={{ color: '#666', marginTop: 4 }}>{t('botMarketplace.subtitle')}</p>

      {collections.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ margin: '0 0 8px' }}>{t('botMarketplace.collections')}</h3>
          {collections.map((collection) => (
            <div key={collection.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 10, marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <strong>{collection.name}</strong>{' '}
                  <span style={{ color: '#666', fontSize: 13 }}>
                    {t('botMarketplace.collectionEntries', { count: collection.entryIds.length })}
                    {collection.description ? ` — ${collection.description}` : ''}
                  </span>
                </div>
                <button
                  className="btn secondary"
                  disabled={installingCollectionId === collection.id}
                  onClick={() => void handleInstallCollection(collection)}
                >
                  {t('botMarketplace.installCollection')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('botMarketplace.searchPlaceholder')}
          style={{ flex: 1, minWidth: 180 }}
        />
        <label>
          {t('botMarketplace.categoryLabel')}{' '}
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t('botMarketplace.categoryAll')}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(t, c)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('botMarketplace.sortLabel')}{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="rating">{t('botMarketplace.sortRating')}</option>
            <option value="installs">{t('botMarketplace.sortInstalls')}</option>
            <option value="name">{t('botMarketplace.sortName')}</option>
            <option value="newest">{t('botMarketplace.sortNewest')}</option>
          </select>
        </label>
      </div>

      {loading && <p>{t('marketplace.loading')}</p>}
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      {notice && <p style={{ color: '#080' }}>{notice}</p>}
      {actionError && <p style={{ color: '#c00' }}>{actionError}</p>}

      {!loading && !error && entries.length === 0 && <p>{t('botMarketplace.noResults')}</p>}
      {!loading &&
        !error &&
        entries.map((entry) => (
          <div key={entry.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <strong>{entry.name}</strong>
              <span style={{ color: '#666', fontSize: 13 }}>
                {entry.kind === 'template' ? t('botMarketplace.template') : t('botMarketplace.published')} ·{' '}
                {categoryLabel(t, entry.category)}
              </span>
            </div>
            <p style={{ margin: '4px 0', color: '#444' }}>{entry.description}</p>
            <div style={{ color: '#666', fontSize: 13 }}>
              {t('marketplace.author', { author: entry.author })} ·{' '}
              {t('marketplace.installs', { count: entry.installs })} ·{' '}
              {entry.ratingCount === 0
                ? t('botMarketplace.unrated')
                : t('botMarketplace.ratingSummary', {
                    average: entry.ratingAverage.toFixed(1),
                    count: entry.ratingCount,
                  })}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn"
                disabled={installingId === entry.id}
                onClick={() => void handleInstall(entry)}
              >
                {installingId === entry.id ? t('botMarketplace.installing') : t('marketplace.install')}
              </button>
              <span style={{ fontSize: 13, color: '#666' }}>{t('botMarketplace.rateThis')}:</span>
              {[1, 2, 3, 4, 5].map((stars) => (
                <button
                  key={stars}
                  className="btn secondary"
                  style={{ padding: '2px 8px' }}
                  disabled={ratingId === entry.id}
                  title={`${stars}`}
                  onClick={() => void handleRate(entry, stars)}
                >
                  {'★'.repeat(stars)}
                </button>
              ))}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn secondary" onClick={() => void handleToggleVersions(entry)}>
                {t('botMarketplace.versions')}
              </button>
              {workspaces.length > 0 && (
                <>
                  <label style={{ fontSize: 13 }}>
                    {t('botMarketplace.installToWorkspace')}{' '}
                    <select value={installWorkspaceId} onChange={(e) => setInstallWorkspaceId(e.target.value)}>
                      {workspaces.map((ws) => (
                        <option key={ws.workspace.id} value={ws.workspace.id}>
                          {ws.workspace.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="btn secondary"
                    disabled={installingId === entry.id || !installWorkspaceId}
                    onClick={() => void handleInstallToWorkspace(entry)}
                  >
                    {t('botMarketplace.installToWorkspaceButton')}
                  </button>
                </>
              )}
            </div>
            {expandedVersionsId === entry.id && (
              <div style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
                {(versionsByEntry[entry.id] ?? []).length === 0 && <div>{t('botMarketplace.noVersions')}</div>}
                {(versionsByEntry[entry.id] ?? []).map((v) => (
                  <div key={v.version}>
                    <strong>v{v.version}</strong> · {new Date(v.at).toLocaleDateString()}
                    {v.changelog ? ` — ${v.changelog}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
