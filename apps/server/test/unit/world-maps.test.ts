import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorldMapRepository } from '../../src/world/maps.js';

const MAIN_YAML = `
world:
  name: からくり町
map:
  rows: 100
  cols: 100
  nodes:
    2-4:
      type: wall
      building_id: building-shrine
    1-7:
      type: normal
      label: 井戸
  buildings:
    - building_id: building-shrine
      name: 神社
      description: 町の神社
      wall_nodes: [2-4]
      door_nodes: [3-4]
      actions: []
  submaps:
    - submap_id: shrine-1f
      name: 神社 内部
      building_id: building-shrine
      rows: 4
      cols: 6
      nodes:
        1-1:
          label: 拝殿
        4-3:
          type: gate
          label: 出入口
`;

describe('WorldMapRepository', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'world-maps-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('YAML を world_id = ファイル名で読み込み、必要な項目だけ返す', () => {
    writeFileSync(join(dir, 'main.yaml'), MAIN_YAML);
    const repo = new WorldMapRepository(dir);

    const map = repo.getMap('main');
    expect(map).not.toBeNull();
    expect(map!.name).toBe('からくり町');
    expect(map!.rows).toBe(100);
    expect(map!.nodes['2-4']).toEqual({ type: 'wall', building_id: 'building-shrine' });
    expect(map!.nodes['1-7']).toEqual({ type: 'normal', label: '井戸' });
    expect(map!.buildings['building-shrine']).toBe('神社');
  });

  it('サブマップを読み込み、type 省略ノードは building_interior 既定にする', () => {
    writeFileSync(join(dir, 'main.yaml'), MAIN_YAML);
    const repo = new WorldMapRepository(dir);

    const submaps = repo.getMap('main')!.submaps;
    expect(submaps).toHaveLength(1);
    expect(submaps[0]).toMatchObject({
      submap_id: 'shrine-1f',
      name: '神社 内部',
      building_id: 'building-shrine',
      rows: 4,
      cols: 6,
    });
    expect(submaps[0]!.nodes['1-1']).toEqual({ type: 'building_interior', label: '拝殿' });
    expect(submaps[0]!.nodes['4-3']).toEqual({ type: 'gate', label: '出入口' });
  });

  it('一覧は main を先頭にし、壊れた YAML は error 付きで返す', () => {
    writeFileSync(join(dir, 'main.yaml'), MAIN_YAML);
    writeFileSync(join(dir, 'sub-a.yaml'), 'world:\n  name: サブ\nmap:\n  rows: 10\n  cols: 12\n');
    writeFileSync(join(dir, 'broken.yaml'), 'world: [invalid');
    const repo = new WorldMapRepository(dir);

    const maps = repo.listMaps();
    expect(maps.map((m) => m.world_id)).toEqual(['main', 'broken', 'sub-a']);
    expect(maps[0]!.error).toBeUndefined();
    expect(maps.find((m) => m.world_id === 'sub-a')).toMatchObject({ rows: 10, cols: 12, name: 'サブ' });
    expect(maps.find((m) => m.world_id === 'broken')!.error).toBeTruthy();
  });

  it('存在しない world_id やパストラバーサルは null を返す', () => {
    writeFileSync(join(dir, 'main.yaml'), MAIN_YAML);
    const repo = new WorldMapRepository(dir);
    expect(repo.getMap('missing')).toBeNull();
    expect(repo.getMap('../main')).toBeNull();
    expect(repo.getMap('.hidden')).toBeNull();
  });

  it('ディレクトリが無ければ空一覧を返す', () => {
    const repo = new WorldMapRepository(join(dir, 'nope'));
    expect(repo.listMaps()).toEqual([]);
  });

  it('ファイル更新後はキャッシュを破棄して再読込する', () => {
    const path = join(dir, 'main.yaml');
    writeFileSync(path, MAIN_YAML);
    const repo = new WorldMapRepository(dir);
    expect(repo.getMap('main')!.name).toBe('からくり町');

    // サイズも変える（mtime の分解能に依存しないように）
    writeFileSync(path, MAIN_YAML.replace('からくり町', 'からくり町2'));
    expect(repo.getMap('main')!.name).toBe('からくり町2');
  });
});
