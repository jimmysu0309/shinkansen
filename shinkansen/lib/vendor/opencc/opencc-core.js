/**
 * 字典，範例："a alpha|b beta" 或 [["a", "alpha"], ["b", "beta"]]
 * @typedef {string|string[][]} DictLike
 */

/**
 * 字典群組
 * @typedef {DictLike[]} DictGroup
 */

/**
 * 地區設定資料
 * @typedef {object} LocalePreset
 * @property {object.<string, DictGroup[]>} from
 * @property {object.<string, DictGroup[]>} to
 * @property {object.<string, {segmentation: DictLike|DictGroup, conversionChain: DictGroup[]}>} [configs]
 */

/**
 * Trie 樹。
 */
 export class Trie {
  // 使用 Map 實作 Trie 樹
  // Trie 的每個節點為一個 Map 物件
  // key 為 code point，value 為子節點（也是一個 Map）。
  // 如果 Map 物件有 trie_val 屬性，則該屬性為值字串，代表替換的字詞。

  constructor() {
    this.map = new Map();
  }

  /**
   * 將一項資料加入字典樹
   * @param {string} s 要匹配的字串
   * @param {string} v 若匹配成功，則替換為此字串
   */
  addWord(s, v) {
    let { map } = this;
    for (const c of s) {
      const cp = c.codePointAt(0);
      const nextMap = map.get(cp);
      if (nextMap == null) {
        const tmp = new Map();
        map.set(cp, tmp);
        map = tmp;
      } else {
        map = nextMap;
      }
    }
    map.trie_val = v;
  }

  /**
     * 讀取字典資料
     * @param {DictLike} d 字典
     */
  loadDict(d) {
    if (typeof d === 'string') {
      d = d.split('|');
      for (const line of d) {
        const [l, r] = line.split(' ');
        if (typeof r !== 'string') {
          throw new TypeError('Invalid dictionary entry: expected string entries to use "source replacement" format.');
        }
        this.addWord(l, r);
      }
    } else {
      for (const arr of d) {
        if (!Array.isArray(arr) || typeof arr[0] !== 'string' || typeof arr[1] !== 'string') {
          throw new TypeError(
            'Invalid dictionary entry: expected [source, replacement] pairs. ' +
            'If you are passing locale dictionaries to ConverterFactory, spread them, for example: ' +
            'ConverterFactory(...Locale.from.cn, ...Locale.to.hk).'
          );
        }
        const [l, r] = arr;
        this.addWord(l, r);
      }
    }
  }

  /**
   * 讀取多個字典資料
   * @param {DictLike[]} arr 字典
   */
  loadDictGroup(arr) {
    arr.slice().reverse().forEach(d => {
      this.loadDict(d);
    });
  }

  matchPrefix(s, i) {
    const n = s.length;
    let t_curr = this.map, k = 0, v;
    for (let j = i; j < n;) {
      const x = s.codePointAt(j);
      j += x > 0xffff ? 2 : 1;

      const t_next = t_curr.get(x);
      if (typeof t_next === 'undefined') {
        break;
      }
      t_curr = t_next;

      const v_curr = t_curr.trie_val;
      if (typeof v_curr !== 'undefined') {
        k = j;
        v = v_curr;
      }
    }
    if (k > 0) {
      return { end: k, value: v };
    }
    return null;
  }

  /**
   * 根據字典樹中的資料轉換字串。
   * @param {string} s 要轉換的字串
   */
  convert(s) {
    const n = s.length, arr = [];
    let orig_i = null;
    for (let i = 0; i < n;) {
      const matched = this.matchPrefix(s, i);
      if (matched) { // 有替代
        if (orig_i !== null) {
          arr.push(s.slice(orig_i, i));
          orig_i = null;
        }
        arr.push(matched.value);
        i = matched.end;
      } else { // 無替代
        if (orig_i === null) {
          orig_i = i;
        }
        i += getUnmatchedLength(s, i);
      }
    }
    if (orig_i !== null) {
      arr.push(s.slice(orig_i, n));
    }
    return arr.join('');
  }
}

function getCodePointLength(s, i) {
  return s.codePointAt(i) > 0xffff ? 2 : 1;
}

function getIdeographicDescriptionArity(cp) {
  if (cp >= 0x2ff0 && cp <= 0x2ff1) return 2;
  if (cp >= 0x2ff2 && cp <= 0x2ff3) return 3;
  if (cp >= 0x2ff4 && cp <= 0x2fff) return 2;
  return 0;
}

function getIdeographicDescriptionSequenceEnd(s, i) {
  const cp = s.codePointAt(i);
  const arity = getIdeographicDescriptionArity(cp);
  if (arity === 0) {
    return 0;
  }

  let end = i + getCodePointLength(s, i);
  for (let n = 0; n < arity; n += 1) {
    if (end >= s.length) {
      return 0;
    }
    const childEnd = getIdeographicDescriptionSequenceEnd(s, end);
    end = childEnd || end + getCodePointLength(s, end);
  }
  return end;
}

function getUnmatchedLength(s, i) {
  const idsEnd = getIdeographicDescriptionSequenceEnd(s, i);
  if (idsEnd > i) {
    return idsEnd - i;
  }
  return getCodePointLength(s, i);
}

/**
 * Create a OpenCC converter
 * @param  {...(DictLike|DictGroup|DictGroup[])} dictGroup
 * @returns The converter that performs the conversion.
 */
export function ConverterFactory(...dictGroups) {
  const trieArr = normalizeConverterFactoryDictGroups(dictGroups).map(grp => {
    const t = new Trie();
    t.loadDictGroup(grp);
    return t;
  });
  /**
   * The converter that performs the conversion.
   * @param {string} s The string to be converted.
   * @returns {string} The converted string.
   */
  function convert(s) {
    return trieArr.reduce((res, t) => {
      return t.convert(res);
    }, s);
  }
  return convert;
}

function isDictPair(entry) {
  return Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string';
}

function isSerializedDict(dict) {
  return typeof dict === 'string' && (dict === '' || dict.includes(' '));
}

function isDictLike(dict) {
  return typeof dict === 'string' || (Array.isArray(dict) && dict.every(isDictPair));
}

function isDictGroup(dictGroup) {
  return Array.isArray(dictGroup) && dictGroup.every(dict => {
    return isSerializedDict(dict) || (Array.isArray(dict) && dict.every(isDictPair));
  });
}

function isDictGroupCollection(dictGroups) {
  return Array.isArray(dictGroups) && dictGroups.every(isDictGroup);
}

function normalizeConverterFactoryDictGroups(dictGroups) {
  return dictGroups.flatMap(dictGroup => {
    if (isDictGroupCollection(dictGroup)) {
      return dictGroup;
    }
    if (isDictGroup(dictGroup)) {
      return [dictGroup];
    }
    if (!Array.isArray(dictGroup)) {
      throw new TypeError('Invalid ConverterFactory argument: expected a dictionary group or locale dictionary collection.');
    }

    const groups = [];
    let i = 0;
    while (i < dictGroup.length && isDictGroup(dictGroup[i])) {
      groups.push(dictGroup[i].slice());
      i += 1;
    }
    const appendedDicts = dictGroup.slice(i);
    if (groups.length > 0 && appendedDicts.length > 0 && appendedDicts.every(isDictLike)) {
      groups[groups.length - 1].push(...appendedDicts);
      return groups;
    }
    return [dictGroup];
  });
}

// v2.0.83：本檔為重新打包版（字典格式已改），zh-convert.js 只用 ConverterFactory；
// ConverterFactoryWithSegmentation / ConverterBuilder / CustomConverter / HTMLConverter /
// Trie.segment 全 repo 無引用，已裁剪（約 230 行 dead code）。
