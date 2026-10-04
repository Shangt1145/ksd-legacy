/* 原型：按《原语组合器逻辑文档》重做的**切分与归属层**。
 *
 * 只做文档里定义的那件事 —— 把一段卡面文本切成"效果单元"，并决定每个单元
 * 受不受前面的条件/选择/触发/目标控制。原语本身仍交给现有的 primitives.parse。
 *
 * 文档规则：
 *   · 换行**没有权重**（只是排版，不是分隔符）
 *   · 句号 `。` → 后面的效果**独立**，不受前面任何条件/选择/触发/目标控制
 *   · 分号 `；` → 后面的效果**仍受**前面的条件/触发/目标控制（和句号相反）
 *   · 没有 `部署：`/`亡计：` 时，**第一句话（到第一个逗号）**就是触发原语；
 *     监听型触发（"友方单位被消灭时"…）也是触发原语，且在第一句话
 *   · 抉择：分号分界成两个选项，第二选项前有"或者"，句号后不受抉择影响
 *
 * 用法（仅评估用，未接入游戏）：
 *   node -e "…require('game/js/parser-v2.js')…"
 */
(function (g) {
  const V2 = {};

  /* 把卡面切成"句"：句号是硬边界，换行不是。
   * 返回 [{ text, kind }]，kind: 'plain' | 'choice'（抉择块） */
  function splitSentences(text) {
    const t = String(text || '').replace(/\s*\n\s*/g, ' ').trim();  // 换行无权重
    if (!t) return [];
    return t.split(/(?<=[。！？])/).map(s => s.trim()).filter(Boolean);
  }

  /* 一句话内按分号切成若干"效果单元"：
   *   第 0 段 = 主效果；后续每段 = **共享主效果的条件**（分号后仍受前面控制）。 */
  function splitClauses(sentence) {
    return sentence.split(/[；;]/).map(s => s.trim()).filter(Boolean);
  }

  /* 触发原语识别：句首的 `部署：` `亡计：` 或监听型触发，
   * 否则按文档 —— **第一句话（到第一个逗号）**是触发原语。 */
  const TRIG_HEAD = /^(部署|亡计)\s*[：:]/;
  const LISTEN = /^(友方|敌方|对方|本单位|我方|你的)?\s*(单位|总部)?\s*(被消灭|被摧毁|攻击时|受到伤害|被压制|被沉默|撤退|部署|登场|移动)\s*(时|后)?/;

  function takeTrigger(clause) {
    const m = clause.match(TRIG_HEAD);
    if (m) return { trig: m[1], rest: clause.slice(m[0].length).trim() };
    // 文档：没有那两个 → 第一句话（到第一个逗号）就是触发
    const i = clause.search(/[，,]/);
    if (i >= 0) return { trig: null, rest: clause.slice(i + 1).trim(), firstPhrase: clause.slice(0, i).trim() };
    // ★ 整句没有逗号时的处理。**不能见"时/后"就切** —— 那会把
    //   「对战太空单位时具有+1攻击力」切成 触发="对战太空单位时" + body="具有+1攻击力"，
    //   主语被丢掉，本来能解析的句子反而解析不了（卫星联盟通用驱逐舰踩过）。
    //   只有**句首就是监听型主语**（友方/敌方/本单位/当/回合…）时才按"时/后"切分。
    // ⚠ **不能**把「每有」和「如果」算进监听主语：它们是数量/条件前缀，
    //   切开会把主体孤立（「每有一张X 对战Y时具有+N攻击力」被切成 body="具有+N攻击力"，
    //   主语与数量全丢）。整句交给原语层才对。
    const LISTEN_HEAD = /^(?:友方|敌方|对方|我方|你的|本单位|该单位|这个单位|当|回合|第一回合|本回合)[^，,。；;]{0,12}?(?:时|后)(?=\S)/;
    const m2 = clause.match(LISTEN_HEAD);
    if (m2 && m2[0].length < clause.length) {
      return { trig: null, rest: clause.slice(m2[0].length).trim(), firstPhrase: m2[0].trim() };
    }
    // 其余情况：整句都是正文，触发交给上层默认（别擅自切）
    return { trig: null, rest: clause, firstPhrase: null };
  }

  /* 主入口：返回结构化的效果单元列表（供评估对比，不直接产出 effects） */
  V2.parse = function (text, opts) {
    const out = [];
    const noPronoun = opts && opts.noPronoun;
    let lastBody = null;                                  // 上一句的正文（供代词指代）
    splitSentences(text).forEach(sent => {
      const clauses = splitClauses(sent);
      // 抉择：整句以「抉择：」开头 → 各分号段是选项
      const isChoice = /^抉择\s*[：:]/.test(clauses[0] || '');
      if (isChoice) {
        // ★ 选项分隔符优先级：**「或者」/「或」> 分号**（Alan 确认，真实卡面两种都有：
        //   `抉择：A。或者B` 用句号+或者；`抉择：A 或B` 用单字"或"；分号是少数）。
        //   先把整句（含跨句号）按 或者/或 切，切不动再退回分号切。
        const raw = clauses.join('；').replace(/^抉择\s*[：:]\s*/, '');
        let opts = raw.split(/或者|或/).map(s => s.replace(/^[。；;\s]+|[。；;\s]+$/g, '').trim()).filter(Boolean);
        if (opts.length < 2) {
          opts = clauses.map(c => c.replace(/^抉择\s*[：:]\s*/, '').replace(/^(?:或者|或)\s*/, '').trim()).filter(Boolean);
        }
        out.push({ kind: 'choice', options: opts });
        return;
      }
      let prevBody = (lastBody && !noPronoun) ? lastBody : null;
      clauses.forEach((c, idx) => {
        const { trig, rest, firstPhrase } = takeTrigger(c);
        let body = (idx > 0 ? c : rest);
        // 代词指向**前一句的目标**（文档 §1.3）：跨句/跨分号都算"前一句"
        if (!noPronoun) {
          body = V2.resolvePronoun(body, prevBody || lastBody);
        }
        out.push({
          kind: 'effect',
          // 分号段（idx>0）继承第 0 段的触发与条件 —— 这就是文档里"分号仍受控制"
          inheritsFrom: idx > 0 ? 0 : null,
          trigger: idx > 0 ? null : trig,
          firstPhrase: idx > 0 ? null : firstPhrase,
          body: body,
        });
        prevBody = body;
        lastBody = body;
      });
    });
    return out;
  };

  /* ★ 代词原语（文档 §1.3）：`其` / `该单位` / `它` / `使其` / `将其` / `对该`
   *   指向**前一句的目标原语** —— 不是新目标，是复用上句选中的那个。
   *   做法：从上句正文里抠出目标短语（"一个敌方单位"这类），把代词替换掉，
   *   再交给原语层（原语层不认识"其"，会退化成 side:'any' 的通用选靶）。
   *   例：上句「压制一个敌方单位」→ 本句「将其消灭」→ 「将一个敌方单位消灭」 */
  const PRONOUN = /^(?:将其|使其|对其|把它|将该|该单位|其|它|该)/;
  // 目标短语：量词 + 阵营 + ≤4 字修饰 + (单位|目标|总部|卡|牌)。**非贪婪**，
  // 否则会把前面的动词一起吃进来（「压制一个敌方单位」→ 整串被当成目标）。
  const TARGET_PHRASE = /((?:一个|所有|全体|随机一个|每张|三张|两张|数张)?\s*(?:敌方|对方|友方|我方|你的)?\s*[\u4e00-\u9fa5]{0,4}?(?:单位|目标|总部|卡|牌))/;
  // 剥掉粘在前面的动词／介词（"压制一个敌方单位" → "一个敌方单位"）
  const LEAD_VERB = /^(?:压制|消灭|摧毁|选择|开发|加入|造成|获得|抽|抽取|使用|弃|移动|移至|部署|召唤|控制|抑制|缴获|复制|转换|使|将|对|把|给)\s*/;

  V2.resolvePronoun = function (body, prevBody) {
    if (!body || !prevBody) return body;
    if (!PRONOUN.test(body)) return body;
    const m = String(prevBody).match(TARGET_PHRASE);
    if (!m || !m[1]) return body;
    const phrase = m[1].trim().replace(LEAD_VERB, '').trim();
    if (!phrase) return body;
    // ⚠ **认不准就别替换**：只接受以"单位/目标/总部"结尾的短语（"卡/牌"太容易误匹配，
    //   曾把「将三张火药机加入手牌」里的"机加入手牌"当目标，产出「机加入手牌花费减为0」）。
    //   错误的替换会**静默产生错误目标**，比原样留着让上层报 unimplemented 更危险。
    if (!/(单位|目标|总部)$/.test(phrase)) return body;
    if (/(加入|消灭|开发|压制|选择|造成|获得)/.test(phrase)) return body;
    // 「将其X」→「将一个敌方单位X」；「使其X」→「使一个敌方单位X」；裸「其X」→「一个敌方单位X」
    const head = body.match(PRONOUN)[0];
    const rest = body.slice(head.length);
    const lead = /将其/.test(head) ? '将' : (/使其|使该/.test(head) ? '使' :
      (/对其|对该|对该/.test(head) ? '对' : ''));
    return (lead ? lead + phrase : phrase) + rest;
  };
  V2.PRONOUN = PRONOUN;
  g.KG_PARSER_V2 = V2;
})(typeof window !== 'undefined' ? window : globalThis);
