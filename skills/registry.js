// ============================================================
// Skills Registry — singleton holding ingested WorkBuddy
// skills as a native, queryable part of Hesi.
//
// Skills are ingested from the local WorkBuddy connector cache
// (connectors/*/skills/SKILL.md) plus any built-in skills in
// skills/builtin/. Persisted to data/skills/catalog.json so
// they survive restarts and are independently editable.
// ============================================================
const fs = require('fs');
const path = require('path');
const { parseSkillMd, scanConnectorCacheSkills } = require('./loader');

const DATA_DIR = path.join(__dirname, '..', 'data', 'skills');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
const BUILTIN_DIR = path.join(__dirname, 'builtin');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadCatalog() {
  ensureDir();
  if (!fs.existsSync(CATALOG_PATH)) {
    return { skills: [], ingestedAt: 0 };
  }
  try {
    const d = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
    return Array.isArray(d.skills) ? d : { skills: [], ingestedAt: 0 };
  } catch (e) {
    return { skills: [], ingestedAt: 0 };
  }
}

function saveCatalog(catalog) {
  ensureDir();
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), 'utf-8');
}

function ingestFromCache() {
  const skills = scanConnectorCacheSkills();
  const byId = {};
  skills.forEach((s) => { byId[s.id] = s; });
  // Merge built-in skills (override cache with Hesi-native ones if same id)
  if (fs.existsSync(BUILTIN_DIR)) {
    for (const f of fs.readdirSync(BUILTIN_DIR)) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(BUILTIN_DIR, f), 'utf-8');
      const s = parseSkillMd(content, path.basename(f, '.md'), '内置');
      s.source = 'builtin';
      byId[s.id] = s;
    }
  }
  const catalog = { skills: Object.values(byId), ingestedAt: Date.now() };
  saveCatalog(catalog);
  return catalog;
}

class SkillRegistry {
  constructor() {
    this._catalog = null;
  }

  _ensure() {
    if (!this._catalog) {
      this._catalog = loadCatalog();
      // Auto-ingest on first use if empty (best-effort; never crash).
      if (!this._catalog.skills || this._catalog.skills.length === 0) {
        try { this._catalog = ingestFromCache(); } catch (e) { /* ignore */ }
      }
    }
    return this._catalog;
  }

  list() {
    return this._ensure().skills;
  }

  get(id) {
    return this._ensure().skills.find((s) => s.id === id) || null;
  }

  getBody(id) {
    const s = this.get(id);
    return s ? s.body : null;
  }

  categories() {
    const set = new Set();
    this.list().forEach((s) => set.add(s.category || '技能'));
    return [...set];
  }

  reingest() {
    this._catalog = ingestFromCache();
    return this._catalog;
  }

  addSkill(skill) {
    const cat = this._ensure();
    const idx = cat.skills.findIndex((s) => s.id === skill.id);
    if (idx >= 0) cat.skills[idx] = skill;
    else cat.skills.push(skill);
    saveCatalog(cat);
    return skill;
  }
}

module.exports = new SkillRegistry();
