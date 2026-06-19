// 评论解析回归测试（无框架，直接 `node test/comments.test.js`）
// 验证 src/comments.js 的 B站评论归一化：根/楼中楼分层、2 层嵌套、
// 大整数 rpid 经 *_str 无损保留、IP属地 strip、去重、按赞排序。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'comments.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(code, ctx);

let fails = 0;
function assert(c, m) { if (!c) { console.error('  FAIL: ' + m); fails++; } else console.log('  ok: ' + m); }

// 仿真 B站 x/v2/reply/wbi/main 响应（真实字段：含 *_str；sub 的 root 为大数字 + root_str 为精确串）
const rootResp = { code: 0, data: {
  cursor: { all_count: 1234, is_end: false, pagination_reply: { next_offset: '{"type":3}' } },
  top_replies: [
    { rpid_str: '90000000000000001', rpid: 90000000000000001, parent: 0, root: 0,
      member: { uname: '置顶用户', mid: 111 }, content: { message: '置顶评论' },
      like: 500, ctime: 1700000000, reply_control: { location: 'IP属地：广东' }, rcount: 0, replies: null } ],
  replies: [
    { rpid_str: '90000000000000002', rpid: 90000000000000002, parent: 0, root: 0,
      member: { uname: '楼主A', mid: 222 }, content: { message: '根评论A' },
      like: 10, ctime: 1700000100, reply_control: { location: 'IP属地：北京' }, rcount: 2,
      replies: [
        { rpid_str: '90000000000000003', parent: 90000000000000002, parent_str: '90000000000000002', root: 90000000000000002, root_str: '90000000000000002',
          member: { uname: '子B' }, content: { message: '回复A的第一条' }, like: 1, ctime: 1700000200, reply_control: {} },
        { rpid_str: '90000000000000004', parent: 90000000000000003, parent_str: '90000000000000003', root: 90000000000000002, root_str: '90000000000000002',
          member: { uname: '子C' }, content: { message: '回复B' }, like: 0, ctime: 1700000300, reply_control: {} } ] },
    { rpid_str: '90000000000000005', parent: 0, root: 0, member: { uname: '楼主D', mid: 333 },
      content: { message: '根评论D' }, like: 3, ctime: 1700000400, reply_control: { location: 'IP属地：上海' }, rcount: 0, replies: null } ] } };

const dupResp = JSON.parse(JSON.stringify(rootResp)); // 重复响应，测去重

const captures = [
  { url: 'https://api.bilibili.com/x/v2/reply/wbi/main?oid=1&type=1', body: JSON.stringify(rootResp) },
  { url: 'https://api.bilibili.com/x/v2/reply/wbi/main?oid=1&type=1&pagination_str=x', body: JSON.stringify(dupResp) },
];

const built = ctx.marineBuildBiliComments(captures);
console.log('stats:', JSON.stringify(built.stats));
assert(built.stats.roots === 3, 'roots=3 (置顶+A+D)，实得 ' + built.stats.roots);
assert(built.stats.subs === 2, 'subs=2（A 下两条），实得 ' + built.stats.subs);
assert(built.stats.count === 5, 'count=5，实得 ' + built.stats.count);
assert(built.stats.maxDepth === 2, 'maxDepth=2');
assert(built.stats.total === 1234, 'total 取自 cursor.all_count');

const a = built.comments.find(c => c.author.name === '楼主A');
assert(a && a.id === '90000000000000002', '大整数 rpid 以字符串无损保留');
assert(a && a.children.length === 2, 'A 挂了 2 条楼中楼');
const top = built.comments.find(c => c.author.name === '置顶用户');
assert(top && top.ipLocation === '广东', 'IP属地前缀被 strip → 广东');
assert(built.comments[0].author.name === '置顶用户', '按点赞降序：置顶(500) 排首位');

const pv = ctx.marineCommentsPreview(built.comments, 100);
assert(/楼主A/.test(pv) && /↳/.test(pv), '预览含嵌套结构');

console.log('\n--- 预览样例 ---\n' + pv);
console.log('\n' + (fails ? '❌ ' + fails + ' 个断言失败' : '✅ 全部通过'));
process.exit(fails ? 1 : 0);
