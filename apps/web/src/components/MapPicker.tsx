import { useEffect, useMemo, useState } from 'react';

import { api, type NpcDto, type WorldMapDto, type WorldMapSummary } from '../lib/api';

const CELL_SIZES = [
  { label: '小', size: 8 },
  { label: '中', size: 14 },
  { label: '大', size: 22 },
];

const TYPE_COLORS: Record<string, string> = {
  normal: 'bg-white',
  wall: 'bg-slate-600',
  door: 'bg-amber-300',
  building_interior: 'bg-slate-200',
  gate: 'bg-violet-300',
  npc: 'bg-sky-300',
  bulletin_board: 'bg-orange-300',
};

// world の PASSABLE_NODE_TYPES と同じ（通行不可ノードは home にできないため選択不可にする）
const IMPASSABLE_TYPES = new Set(['wall', 'npc', 'bulletin_board']);

const LEGEND: Array<{ label: string; className: string }> = [
  { label: '通路', className: 'bg-white border border-slate-300' },
  { label: '壁', className: 'bg-slate-600' },
  { label: 'ドア', className: 'bg-amber-300' },
  { label: '建物内', className: 'bg-slate-200' },
  { label: 'ゲート', className: 'bg-violet-300' },
  { label: 'world組込NPC', className: 'bg-sky-300' },
  { label: '掲示板', className: 'bg-orange-300' },
];

/** world の nodeRef 形式（"行-列" / "submap_id:行-列"）を {mapId, nodeId} に分解する。 */
function parseNodeRef(ref: string): { mapId: string | null; nodeId: string } | null {
  const match = /^(?:([a-z0-9][a-z0-9-]*):)?(\d+-\d+)$/.exec(ref);
  if (!match) return null;
  return { mapId: match[1] ?? null, nodeId: match[2]! };
}

interface MapPickerProps {
  title: string;
  /** 現在の入力値（例: "50-50" / "ryokan-1f:2-3"）。該当セルを強調表示する。 */
  value?: string;
  /** 編集中の NPC（マーカー表示で「この NPC」と区別する）。新規作成時は undefined。 */
  currentNpcId?: string;
  onSelect: (nodeId: string) => void;
  onClose: () => void;
}

interface Marker {
  name: string;
  isCurrent: boolean;
  kind: 'home' | 'position';
}

export default function MapPicker({ title, value, currentNpcId, onSelect, onClose }: MapPickerProps) {
  const [maps, setMaps] = useState<WorldMapSummary[] | null>(null);
  const [mapDir, setMapDir] = useState('');
  const [npcs, setNpcs] = useState<NpcDto[]>([]);
  const [worldId, setWorldId] = useState<string | null>(null);
  const [map, setMap] = useState<WorldMapDto | null>(null);
  /** null = 屋外、それ以外は submap_id。 */
  const [floorId, setFloorId] = useState<string | null>(null);
  const [cellSize, setCellSize] = useState(14);
  const [error, setError] = useState('');

  const parsedValue = value ? parseNodeRef(value) : null;

  useEffect(() => {
    api<{ maps: WorldMapSummary[]; map_dir: string }>('/api/maps')
      .then(({ maps, map_dir }) => {
        setMaps(maps);
        setMapDir(map_dir);
        const usable = maps.filter((m) => !m.error);
        setWorldId(usable.find((m) => m.world_id === 'main')?.world_id ?? usable[0]?.world_id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api<{ npcs: NpcDto[] }>('/api/npcs')
      .then(({ npcs }) => setNpcs(npcs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!worldId) return;
    setMap(null);
    setError('');
    api<WorldMapDto>(`/api/maps/${worldId}`)
      .then((loaded) => {
        setMap(loaded);
        // 入力値がサブマップ修飾つきなら、そのフロアを初期表示する
        const valueMapId = value ? parseNodeRef(value)?.mapId : null;
        setFloorId(valueMapId && loaded.submaps.some((s) => s.submap_id === valueMapId) ? valueMapId : null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // value はモーダル表示中に変わらない（選択時に閉じる）ため依存に含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  const floor = useMemo(() => {
    if (!map) return null;
    if (floorId === null) {
      return { rows: map.rows, cols: map.cols, nodes: map.nodes, defaultType: 'normal', prefix: '' };
    }
    const submap = map.submaps.find((s) => s.submap_id === floorId);
    if (!submap) return null;
    return {
      rows: submap.rows,
      cols: submap.cols,
      nodes: submap.nodes,
      defaultType: 'building_interior',
      prefix: `${submap.submap_id}:`,
    };
  }, [map, floorId]);

  // ノード ID（フロア内の "行-列"） → 設定済み NPC マーカー。
  // home はメインワールド（main）のログイン位置なので main のみに出す。
  // runtime の node_id は world が現在マップ基準の無修飾で返すため、無修飾は屋外として扱う。
  const markers = useMemo(() => {
    const result = new Map<string, Marker[]>();
    const add = (ref: string | null | undefined, marker: Marker) => {
      if (!ref) return;
      const parsed = parseNodeRef(ref);
      if (!parsed || parsed.mapId !== floorId) return;
      const list = result.get(parsed.nodeId) ?? [];
      list.push(marker);
      result.set(parsed.nodeId, list);
    };
    for (const npc of npcs) {
      const isCurrent = npc.npc_id === currentNpcId;
      if (worldId === 'main') {
        add(npc.home_node_id, { name: npc.name, isCurrent, kind: 'home' });
      }
      const runtime = npc.runtime;
      if (runtime?.logged_in && runtime.node_id && (runtime.world_id ?? 'main') === worldId) {
        add(runtime.node_id, { name: npc.name, isCurrent, kind: 'position' });
      }
    }
    return result;
  }, [npcs, worldId, floorId, currentNpcId]);

  const grid = useMemo(() => {
    if (!map || !floor) return null;
    const selectedNodeId = parsedValue && parsedValue.mapId === floorId ? parsedValue.nodeId : null;
    const cellTitle = (nodeId: string, label?: string, buildingId?: string): string => {
      const parts = [`${floor.prefix}${nodeId}`];
      if (label) parts.push(label);
      else if (buildingId) parts.push(map.buildings[buildingId] ?? buildingId);
      for (const marker of markers.get(nodeId) ?? []) {
        parts.push(`${marker.kind === 'home' ? '🏠' : '📍'}${marker.name}`);
      }
      return parts.join(' ');
    };
    const cells = [];
    // world の座標は 1 始まり（1-1 〜 rows-cols）
    for (let row = 1; row <= floor.rows; row++) {
      for (let col = 1; col <= floor.cols; col++) {
        const nodeId = `${row}-${col}`;
        const node = floor.nodes[nodeId];
        const type = node?.type ?? floor.defaultType;
        const marker = markers.get(nodeId)?.[0];
        const impassable = IMPASSABLE_TYPES.has(type);
        const isSelected = nodeId === selectedNodeId;
        cells.push(
          <div
            key={nodeId}
            title={cellTitle(nodeId, node?.label, node?.building_id)}
            onClick={impassable ? undefined : () => onSelect(`${floor.prefix}${nodeId}`)}
            className={`relative ${TYPE_COLORS[type] ?? 'bg-white'} ${
              impassable ? '' : 'cursor-pointer hover:ring-2 hover:ring-sky-500 hover:z-10'
            } ${isSelected ? 'ring-2 ring-red-500 z-10' : ''}`}
            style={{ width: cellSize, height: cellSize }}
          >
            {marker && (
              <span
                className={`absolute inset-0 flex items-center justify-center rounded-full text-white ${
                  marker.isCurrent ? 'bg-red-500' : marker.kind === 'home' ? 'bg-emerald-600' : 'bg-blue-500'
                }`}
                style={{ fontSize: Math.max(cellSize - 8, 6) }}
              >
                {cellSize >= 14 ? marker.name.slice(0, 1) : ''}
              </span>
            )}
          </div>,
        );
      }
    }
    return cells;
  }, [map, floor, floorId, markers, cellSize, parsedValue, onSelect]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
          <h3 className="font-semibold">{title}</h3>
          {maps && maps.length > 0 && (
            <select
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              value={worldId ?? ''}
              onChange={(e) => setWorldId(e.target.value)}
            >
              {maps.map((m) => (
                <option key={m.world_id} value={m.world_id} disabled={Boolean(m.error)}>
                  {m.world_id === 'main' ? `メイン: ${m.name}` : `サブ: ${m.name}`}
                  {m.error ? '（読込エラー）' : ''}
                </option>
              ))}
            </select>
          )}
          {map && map.submaps.length > 0 && (
            <select
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              value={floorId ?? ''}
              onChange={(e) => setFloorId(e.target.value || null)}
            >
              <option value="">屋外</option>
              {map.submaps.map((submap) => (
                <option key={submap.submap_id} value={submap.submap_id}>
                  🏢 {submap.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-1 text-sm">
            {CELL_SIZES.map(({ label, size }) => (
              <button
                key={size}
                type="button"
                onClick={() => setCellSize(size)}
                className={`rounded px-2 py-1 ${cellSize === size ? 'bg-slate-900 text-white' : 'border border-slate-300 hover:bg-slate-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} className="ml-auto rounded px-3 py-1 text-sm text-slate-500 hover:bg-slate-100">
            閉じる ✕
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs text-slate-600">
          {LEGEND.map(({ label, className }) => (
            <span key={label} className="flex items-center gap-1">
              <span className={`inline-block h-3 w-3 rounded-sm ${className}`} />
              {label}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-full bg-emerald-600" />
            設定済み home
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-full bg-blue-500" />
            現在位置
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-full bg-red-500" />
            この NPC
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {maps && maps.length === 0 && (
            <div className="space-y-2 py-8 text-center text-sm text-slate-600">
              <p>マップが登録されていません。</p>
              <p>
                karakuri-world のワールド定義 YAML を <code className="rounded bg-slate-100 px-1">{mapDir}</code> に置いてください
                （メインワールドは <code className="rounded bg-slate-100 px-1">main.yaml</code>、サブワールドは{' '}
                <code className="rounded bg-slate-100 px-1">&lt;world_id&gt;.yaml</code>）。
              </p>
            </div>
          )}
          {!map && maps && maps.length > 0 && !error && <p className="py-8 text-center text-sm text-slate-500">読み込み中…</p>}
          {map && floor && (
            <>
              {worldId !== 'main' && (
                <p className="mb-2 text-xs text-amber-700">
                  ⚠ home / 移動範囲の中心はメインワールドのログイン位置として使われます。サブワールドの座標を設定する場合は運用に注意してください。
                </p>
              )}
              {floorId !== null && (
                <p className="mb-2 text-xs text-slate-500">
                  建物内サブマップ。選択すると <code className="rounded bg-slate-100 px-1">{floorId}:行-列</code> 形式で設定されます。
                </p>
              )}
              <div
                className="inline-grid border border-slate-300 bg-slate-100"
                style={{ gridTemplateColumns: `repeat(${floor.cols}, ${cellSize}px)`, gap: 1 }}
              >
                {grid}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
