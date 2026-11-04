import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeZip, readZip } from '../zip.js';
import { buildTeamPackage, readTeamPackage, applyTeamPackage, buildMatchPackage, readMatchPackage, importMatch, statsCsv } from '../transfer.js';

const PNG = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
const roster = [{ id: 'a', num: 7, name: 'Андрей', role: 's', setter: true }, { id: 'b', num: 11, name: 'Максим', role: 'oh' }];
const settings = { teamName: 'Звезда', emblem: PNG, kit: { main: '#fff' }, system: '5-1', presets: [{ id: 'main', name: 'Основной' }], qualityZones: '123', opponents: [{ id: 'o1', name: 'Северные', emblem: PNG }] };

test('ZIP: что положили, то и достали (русские имена, сжатие и без него)', () => {
  const files = [{ name: 'team.json', data: '{"a":1}' }, { name: 'Эмблемы/Звезда.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, { name: 'big.txt', data: 'x'.repeat(5000) }];
  const back = readZip(makeZip(files));
  assert.deepEqual(back.map(f => f.name), files.map(f => f.name));
  assert.equal(back[0].data.toString(), '{"a":1}');
  assert.equal(back[2].data.toString(), 'x'.repeat(5000));
  assert.throws(() => readZip(Buffer.from('not a zip')), /не ZIP/);
});

test('ZIP открывается обычным архиватором (python zipfile)', t => {
  let py = 'python3';
  try { execFileSync(py, ['--version']); } catch { return t.skip('нет python3'); }
  const dir = mkdtempSync(path.join(tmpdir(), 'vm-zip-'));
  const f = path.join(dir, 'a.zip');
  writeFileSync(f, makeZip([{ name: 'Состав.csv', data: '№;Имя\n7;Андрей' }, { name: 'b.txt', data: 'y'.repeat(3000) }]));
  const out = execFileSync(py, ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("|".join(z.namelist()));print(z.read("Состав.csv").decode())', f]).toString();
  assert.match(out, /Состав\.csv\|b\.txt/);
  assert.match(out, /7;Андрей/);
});

test('пакет команды: только выбранные части; загрузка — слиянием, без удаления', () => {
  const pkg = buildTeamPackage({ roster, settings }, ['roster', 'opps']);
  assert.match(pkg.name, /^Команда_Звезда_\d{4}-\d\d-\d\d\.zip$/);
  const names = readZip(pkg.data).map(f => f.name);
  assert.ok(names.includes('team.json') && names.includes('Состав.csv') && names.includes('Эмблемы/Северные.png'));
  const team = readTeamPackage(pkg.data);
  assert.deepEqual(team.parts, ['roster', 'opps']);
  assert.equal(team.kit, undefined); // форма не выбрана — её нет в файле
  // На другом компьютере: свой игрок c, номер 7 записан с другим id — обновится по номеру и имени.
  const there = { roster: [{ id: 'x7', num: 7, name: 'андрей', role: 'oh' }, { id: 'c', num: 3, name: 'Илья' }], settings: { teamName: 'Мы', opponents: [{ id: 'z', name: 'северные' }] } };
  const { roster: r, settingsPatch, report } = applyTeamPackage(there, team, ['roster', 'opps', 'kit']);
  assert.equal(r.length, 3); // c остался, Максим добавился
  assert.equal(r.find(p => p.id === 'x7').role, 's');
  assert.ok(r.some(p => p.name === 'Максим'));
  assert.deepEqual(report.roster, { added: 1, updated: 1 });
  assert.equal(settingsPatch.opponents.length, 1); // соперник найден по названию
  assert.equal(settingsPatch.teamName, undefined); // части kit в пакете нет — не трогаем
  assert.throws(() => readTeamPackage(Buffer.from('{"format":"other"}')), /не пакет команды/);
  assert.throws(() => readTeamPackage(Buffer.from('№;Имя')), /не пакет команды/);
});

test('матч: архив → другой компьютер: новый id при совпадении, соперник и игроки добавляются', () => {
  const match = { id: 'm1', opponentId: 'o1', opponent: 'Северные', created: '2026-11-03T10:00:00Z', roster, videos: [{ name: 'a.mp4' }], events: [{ t: 'set', lineup: ['a', 'b'], weServe: true }, { t: 'act', skill: 'serve', res: 'ace', p: 'a' }] };
  const pkg = buildMatchPackage(match, { settings }, { serve: { ace: 'Эйс' } });
  const names = readZip(pkg.data).map(f => f.name);
  assert.deepEqual(names, ['match.json', 'События.csv', 'ПРОЧТИ.txt']);
  assert.match(readZip(pkg.data)[1].data.toString(), /Эйс;7 Андрей/);
  const back = readMatchPackage(pkg.data);
  const res = importMatch({ roster: [], settings: { opponents: [] }, ids: new Set(['m1']) }, back);
  assert.notEqual(res.match.id, 'm1');
  assert.deepEqual(res.match.videos, []);
  assert.equal(res.opponents[0].name, 'Северные');
  assert.equal(res.roster.length, 2);
  assert.ok(res.roster.every(p => p.active === false)); // новые игроки — в запас
});

test('таблица статистики: строка на игрока, Excel-формат (BOM, «;»)', () => {
  const m = { id: 'm1', roster, events: [{ t: 'set', lineup: ['a', 'b', 'a', 'b', 'a', 'b'], weServe: true }, { t: 'act', skill: 'serve', res: 'ace', p: 'a' }, { t: 'act', skill: 'serve', res: 'error', p: 'a' }] };
  const csv = statsCsv([m]);
  assert.ok(csv.startsWith('﻿№;Игрок;'));
  const row = csv.split('\r\n').find(l => l.startsWith('7;'));
  assert.ok(row, 'есть строка игрока №7');
  assert.match(row, /^7;Андрей;1;1;1;0;/); // очки 1, ошибки 1, разница 0
});
