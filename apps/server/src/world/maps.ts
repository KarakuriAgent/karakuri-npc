import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { load as loadYaml } from 'js-yaml';
import { z } from 'zod';

/**
 * karakuri-world のワールド定義 YAML（メインマップ / サブワールド共通）を
 * NPC 配置 UI 用に読み込む。WORLD_MAP_DIR に `<world_id>.yaml` として置く。
 * メインワールドは world 側の MAIN_WORLD_ID に合わせて `main.yaml`。
 */

const nodeConfigSchema = z.looseObject({
  type: z.string().optional(),
  label: z.string().optional(),
  building_id: z.string().optional(),
});

// world 側スキーマの厳密な検証はしない（world 側が正）。配置 UI に必要な項目だけ拾う。
const mapYamlSchema = z.looseObject({
  world: z.looseObject({ name: z.string().optional() }).optional(),
  map: z.looseObject({
    rows: z.coerce.number().int().min(1).max(1000),
    cols: z.coerce.number().int().min(1).max(1000),
    nodes: z.record(z.string(), nodeConfigSchema).optional(),
    buildings: z
      .array(z.looseObject({ building_id: z.string(), name: z.string().optional() }))
      .optional(),
    submaps: z
      .array(
        z.looseObject({
          submap_id: z.string(),
          name: z.string().optional(),
          building_id: z.string().optional(),
          rows: z.coerce.number().int().min(1).max(1000),
          cols: z.coerce.number().int().min(1).max(1000),
          nodes: z.record(z.string(), nodeConfigSchema).optional(),
        }),
      )
      .optional(),
  }),
});

export interface WorldMapNode {
  type: string;
  label?: string;
  building_id?: string;
}

export interface WorldMapSummary {
  world_id: string;
  name: string;
  rows: number;
  cols: number;
  /** YAML の読み込みに失敗した場合のみ（rows/cols は 0）。 */
  error?: string;
}

export interface WorldSubmap {
  submap_id: string;
  name: string;
  building_id?: string;
  rows: number;
  cols: number;
  /** 未定義ノードの既定は building_interior（world 側仕様。屋外の normal 既定と異なる）。 */
  nodes: Record<string, WorldMapNode>;
}

export interface WorldMap extends WorldMapSummary {
  nodes: Record<string, WorldMapNode>;
  /** building_id → 表示名（wall セルのツールチップ用）。 */
  buildings: Record<string, string>;
  /** 建物内サブマップ。node 参照は "submap_id:行-列" 形式。 */
  submaps: WorldSubmap[];
}

const WORLD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  map: WorldMap;
}

export class WorldMapRepository {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly dir: string) {}

  /** ディレクトリ内の *.yaml / *.yml を列挙する（ファイル名 = world_id）。 */
  listMaps(): WorldMapSummary[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((file) => ['.yaml', '.yml'].includes(extname(file)))
      .map((file) => basename(file, extname(file)))
      .filter((worldId) => WORLD_ID_PATTERN.test(worldId))
      .sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
      .map((worldId) => {
        try {
          const { nodes: _nodes, buildings: _buildings, submaps: _submaps, ...summary } = this.getMap(worldId)!;
          return summary;
        } catch (error) {
          return {
            world_id: worldId,
            name: worldId,
            rows: 0,
            cols: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
  }

  /** world_id に対応する YAML を読む。無ければ null、壊れていれば throw。 */
  getMap(worldId: string): WorldMap | null {
    if (!WORLD_ID_PATTERN.test(worldId)) return null;
    const path = ['.yaml', '.yml']
      .map((ext) => join(this.dir, `${worldId}${ext}`))
      .find((candidate) => existsSync(candidate));
    if (!path) return null;

    const stat = statSync(path);
    const cached = this.cache.get(worldId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.map;
    }

    const raw = loadYaml(readFileSync(path, 'utf8'));
    const parsed = mapYamlSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `マップ YAML の形式が不正です（map.rows / map.cols が必要）: ${basename(path)}`,
      );
    }

    const buildings: Record<string, string> = {};
    for (const building of parsed.data.map.buildings ?? []) {
      if (building.name) buildings[building.building_id] = building.name;
    }
    // サブマップの未定義ノードは building_interior 既定（world 側仕様）のため type 省略を許す
    const collectNodes = (
      raw: Record<string, z.infer<typeof nodeConfigSchema>> | undefined,
      defaultType: string,
    ): Record<string, WorldMapNode> => {
      const nodes: Record<string, WorldMapNode> = {};
      for (const [nodeId, node] of Object.entries(raw ?? {})) {
        if (!/^\d+-\d+$/.test(nodeId)) continue;
        nodes[nodeId] = {
          type: node.type ?? defaultType,
          ...(node.label ? { label: node.label } : {}),
          ...(node.building_id ? { building_id: node.building_id } : {}),
        };
      }
      return nodes;
    };

    const map: WorldMap = {
      world_id: worldId,
      name: parsed.data.world?.name ?? worldId,
      rows: parsed.data.map.rows,
      cols: parsed.data.map.cols,
      nodes: collectNodes(parsed.data.map.nodes, 'normal'),
      buildings,
      submaps: (parsed.data.map.submaps ?? []).map((submap) => ({
        submap_id: submap.submap_id,
        name: submap.name ?? submap.submap_id,
        ...(submap.building_id ? { building_id: submap.building_id } : {}),
        rows: submap.rows,
        cols: submap.cols,
        nodes: collectNodes(submap.nodes, 'building_interior'),
      })),
    };
    this.cache.set(worldId, { mtimeMs: stat.mtimeMs, size: stat.size, map });
    return map;
  }
}
