#!/usr/bin/env python3
# marine-extension/tests/talktrack-metrics.py
# 用法: python3 talktrack-metrics.py samples.json [形态库.json]
# samples.json: [{key,status,text, pageTerms?:[...]}]
# 退出码 0 = 全部达标。跑满 20 条（且 history 已有 >=12 条）之后再判。
import json, re, sys, statistics, itertools
from collections import Counter

APHORISM = r'(不是.{1,15}[，,].{0,4}(而)?是|才是真|最怕的不是|反而更|才是研究|与其.{1,12}不如)'
PERSON   = r'师兄|师姐|导师|老师|老板|对象|同门|组会|师门'
PIVOT    = r'后来|于是|随后|直到|这才'
DUMP     = r'(丢进|扔进|甩进|塞进)'
RIVALS   = ['zotero','endnote','gemini','gpt','overleaf','prism','prsim','latex','飞书','notion','mendeley']
BANNED   = ['确实','真省','才是真','真正','一站式','赋能','闭环','丝滑','省心','生产力']
# 与 形态库.json 的 grain 同源；传第二个参数时从文件读，否则用这份内置副本
GRAIN = ['一听一个不吱声','骂的太脏','懒得不能再烂','整那么多','跳来跳去','无非','分分钟',
         '一招制敌','跪下','不争气','顶多','起初','啥也不懂','死读书','麻木','当场就解决',
         '一顿输出','太松懈','背不起来这一口锅','不妨试试','没啥问题','不吱声','充分怀疑','直接冲']

def sents(t): return [s for s in re.split(r'[。！？!?\n]', t) if s.strip()]
def tail(t):
    s = sents(t)
    return s[-1].strip() if s else ''
def bpos(t):
    i = t.lower().find('scholay')
    return i / len(t) if i >= 0 and t else None
def bverb(t):
    i = t.lower().find('scholay')
    return re.sub(r'[\s，,、的]', '', t[max(0, i-2):i]) if i > 0 else ''
def fp(t):
    p = bpos(t)
    return (t.strip()[:2],
            bverb(t),
            bool(re.search(PERSON, t)),
            int(p*4) if p is not None else 9,
            bool(re.search(APHORISM, tail(t))))

def main(path, shapes_path=None):
    grain = GRAIN
    if shapes_path:
        grain = json.load(open(shapes_path)).get('grain', GRAIN)
    data = json.load(open(path))
    T = [d['text'] for d in data if d.get('status') in (None, 'posted', 'filled')]
    n = len(T)
    if n < 20:
        print(f'!! 样本只有 {n} 条，不足 20 条，结论不作数');
    L = [len(t) for t in T]
    P = [p for p in (bpos(t) for t in T) if p is not None]
    sc = Counter(len(sents(t)) for t in T)
    F = [fp(t) for t in T]
    pairs = list(itertools.combinations(range(n), 2))
    dup = sum(1 for i, j in pairs if sum(a == b for a, b in zip(F[i], F[j])) >= 4)
    nn = []
    for i in range(n):
        best = max(sum(a == b for a, b in zip(F[i], F[j])) for j in range(n) if j != i) if n > 1 else 0
        nn.append(best / 5)
    terms = [d.get('pageTerms') for d in data if d.get('status') in (None,'posted','filled')]
    rel = None
    if any(terms):
        hit = [1 if (tm and any(w and w in t for w in tm)) else 0 for t, tm in zip(T, terms)]
        rel = sum(hit) / n

    checks = [
        ('硬需求·每条含 scholay',    sum('scholay' in t.lower() for t in T)/n,                    lambda v: v == 1.0,           1.000),
        ('硬需求·页面相关率',        rel,                                                          lambda v: v is None or v >= 0.90, None),
        ('对仗收尾率',               sum(bool(re.search(APHORISM, tail(t))) for t in T)/n,        lambda v: v <= 0.10,          0.358),
        ('语气词收尾率',             sum(bool(re.search(r'[啊吧呗嘛呀]$', tail(t))) for t in T)/n, lambda v: v >= 0.25,          0.000),
        ('「后来/于是」转折率',      sum(bool(re.search(PIVOT, t)) for t in T)/n,                 lambda v: v <= 0.25,          0.849),
        ('人物出场率(双侧)',         sum(bool(re.search(PERSON, t)) for t in T)/n,                lambda v: 0.25 <= v <= 0.70,  0.925),
        ('无「我」条目占比',         sum('我' not in t for t in T)/n,                             lambda v: v >= 0.15,          0.000),
        ('让步/指示词起手率',        sum(bool(re.match(r'^(这期|这套|这种|这类|这个)', t.strip())) for t in T)/n, lambda v: v <= 0.12, 0.358),
        ('「丢进X」类命中率',        sum(bool(re.search(DUMP, t)) for t in T)/n,                  lambda v: v == 0.0,           0.434),
        ('scholay前置动词最高频占比', Counter(bverb(t) for t in T).most_common(1)[0][1]/n,        lambda v: v <= 0.30,          0.434),
        ('长度变异系数',             statistics.pstdev(L)/statistics.mean(L),                     lambda v: v >= 0.22,          0.106),
        ('最大句数桶占比',           max(sc.values())/n,                                          lambda v: v <= 0.55,          0.868),
        ('scholay位置离散度(sd)',    statistics.pstdev(P) if P else 0.0,                          lambda v: v >= 0.15,          0.086),
        ('母稿原词嵌入率',           sum(any(g in t for g in grain) for t in T)/n,                lambda v: v >= 0.60,          0.000),
        # 区间不是下限：母稿同一个作者 scholay/Scholay/SCHOLAY 三种都写过（8/2/1），
        # 全部小写和全部大写一样，都是「同一台机器」的签名。
        ('小写 scholay 占比(区间)',  sum('scholay' in t for t in T)/n,                            lambda v: 0.55 <= v <= 0.95,  0.000),
        # 以下三项来自运营侧的评论区习惯观察。同样都是区间——
        # 「每条都不带句号」和「每条都带句号」是同一种破绽。
        ('末尾无标点率(区间)',       sum(not re.search(r'[。，,.!！?？…~～]$', t.strip()) for t in T)/n, lambda v: 0.55 <= v <= 0.95, None),
        # 母稿 1/6 用过引号，所以上限取 0.20 而不是 0.10 —— 比人还严的阈值不是好阈值。
        ('双引号出现率',             sum(bool(re.search(r'[「」『』“”\"]', t)) for t in T)/n,      lambda v: v <= 0.20,          None),
        # 只设上限不设下限：空格断句是运营侧的评论区观察，但母稿 0/6 从没这么写过。
        # 没有证据支持的行为可以允许，不该强制。
        ('空格代替标点占比(上限)',   sum(bool(re.search(r'[\u4e00-\u9fff] +[\u4e00-\u9fff]', t)) for t in T)/n, lambda v: v <= 0.45, None),
        ('含阿拉伯数字率',           sum(bool(re.search(r'[0-9]', t)) for t in T)/n,              lambda v: v >= 0.30,          0.057),
        ('禁止词条均命中数',         sum(sum(b in t for b in BANNED) for t in T)/n,               lambda v: v <= 0.15,          0.660),
        ('合规·点名替代品占比(上限)', sum(any(r in t.lower() for r in RIVALS) for t in T)/n,      lambda v: v <= 0.35,          0.396),
        ('骨架近重复对占比',         dup/len(pairs) if pairs else 0.0,                            lambda v: v <= 0.02,          0.078),
        ('骨架最近邻相似度均值',     sum(nn)/n,                                                   lambda v: v <= 0.55,          0.774),
    ]
    ok = True
    print(f'{"指标":<30}{"实测":>9}{"基线":>9}  判定')
    for name, value, rule, base in checks:
        passed = rule(value)
        ok &= bool(passed)
        b = '-' if base is None else f'{base:.3f}'
        if value is None:
            v, mark = 'n/a', 'SKIP'
        else:
            v = f'{value:.3f}' if isinstance(value, float) else str(value)
            mark = 'PASS' if passed else 'FAIL'
        print(f'{name:<30}{v:>9}{b:>9}  {mark}')
    print('\n结论:', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
