"""语义检索: top_n + 绝对阈值 + 断崖检测 + 关键词加权"""
import numpy as np

from config import load_config
import store


def _keyword_hit(query: str, content: str, category: str) -> float:
    """关键词加权: 完整词/核心词命中加分"""
    q = query.lower()
    c = content.lower()
    if not q or not c:
        return 0.0
    boost = 0.0
    for word in q.split():
        if len(word) >= 2 and word in c:
            boost += 0.05
    # 类别命中(用户问"我的偏好" → preference 类加成)
    if "偏好" in q and category == "preference":
        boost += 0.1
    if "目标" in q and category == "goal":
        boost += 0.1
    if "决定" in q and category == "decision":
        boost += 0.1
    if "事实" in q and category == "fact":
        boost += 0.1
    return min(boost, 0.3)


# 注入时的类别分组。同一组内的记忆竞争有限的注入位。
# 背景：库内 evidence(807) + thesis(96) 占 59%，且文本是论述性的、
# 与提问天然更相似，纯相关度排序会把"用户的偏好/目标"系统性挤出注入位。
CATEGORY_GROUPS = {
    "preference": "profile",
    "goal": "profile",
    "decision": "profile",
    "fact": "profile",
    "evidence": "content",
    "thesis": "content",
    "knowledge": "knowledge",
}
DEFAULT_QUOTA = {"profile": 2, "content": 2, "knowledge": 1}

# 分组默认门槛。背景(实测同一条提问对全库所有记忆的原始相似度):
#
#   category     top1    >0.5 占比
#   preference   0.787   16%     ← 短、具体, 跨问题都能命中 —— 最容易进来
#   goal         0.664   13%
#   decision     0.643   11%
#   thesis       0.698    8%
#   evidence     0.666    8%
#   fact         0.630    7%     ← 长文本论述, 只有真相关时才像
#   knowledge    0.619    6%
#
# 含义: 同一个 0.5 门槛对各类并非同一把尺子。对 preference 是"轻松过",
# 对 fact/evidence 是"基本卡死"。所以按组给不同门槛:
#   档案类(profile) 门槛压低 —— 用户的偏好/目标本来就该优先被带上
#   内容类(content) 门槛提高 —— 认知库占 59%, 不放高会淹掉档案
# 2026-10-06: 从单一 group_min_score 改成分组门檻。
DEFAULT_GROUP_MIN = {"profile": 0.52, "content": 0.55, "knowledge": 0.45}

# 单类微调: 同类内还能再分档。preference 最该被带上, 门槛再压一档;
# fact/evidence 最容易被无关提问沾到, 门槛再抬一档。
# 未列出的类别用其所属组的默认值。
# 单类微调: 同类内还能再分档。
#
# 门檻值是照区分度定的, 不是拍脑袋。实测「无关提问」vs「相关提问」
# 的各类 top1 相似度:
#
#   category     无关(天气/吃饭)   相关(偏好/简历)   区分度
#   preference   0.507 ~ 0.535    0.675 ~ 0.787    ★★★ 强
#   goal         0.486 ~ 0.488    0.538 ~ 0.664     中
#   decision     0.472 ~ 0.474    0.539 ~ 0.643     中
#   fact         0.503 ~ 0.523    0.550 ~ 0.591     ✗ 几乎无
#   evidence     0.517 ~ 0.530    0.554 ~ 0.666     ✗ 弱
#   thesis       0.431 ~ 0.458    0.501 ~ 0.609     中
#   knowledge    0.441 ~ 0.443    0.485 ~ 0.619     中
#
# 关键发现: fact/evidence 无关时也能到 0.52, 相关时才 0.55 —— 区分度
# 极小。所以它们的门檻必须抬到 0.55 以上才有意义, 否则无关提问照样
# 硬塞(实测「今晚吃什么」召回「记住数字 7」)。
# 而 preference 拉开极大, 门檻压低也不怕噪声。
DEFAULT_CAT_MIN = {
    "preference": 0.55,   # 区分度最强(无关≤0.54, 相关≥0.67), 0.55 正好卡在分界
    "goal": 0.52,
    "decision": 0.52,
    "fact": 0.55,         # 几乎无区分度, 必须抬到高于无关时的 0.52
    "thesis": 0.50,
    "evidence": 0.56,     # 同上; 略高于 fact(它无关时能到 0.53)
}


def _group_of(category: str) -> str:
    return CATEGORY_GROUPS.get(category, "content")


class Retriever:
    def __init__(self, cfg=None):
        cfg = cfg or load_config()
        r = cfg.get("retrieval", {})
        self.top_n = int(r.get("top_n", 5))
        self.min_score = float(r.get("min_score", 0.5))
        self.cliff_ratio = float(r.get("cliff_ratio", 1.5))
        self.keyword_boost = float(r.get("keyword_boost", 0.15))
        self.k_candidates = int(r.get("k_candidates", 30))
        # 共享档：跨 bot 可见的一档（用户画像 / 环境事实）。
        # 置空字符串即关闭共享，回到纯隔离。
        self.shared_ns = str(r.get("shared_namespace", "shared") or "").strip()
        # 注入时给共享档预留的条数。必须预留：共享条目多是无归属的短事实，
        # 分数通常不占优，若只靠"排完再补"必然被最后的 top_n 截断掉。
        self.shared_slots = max(int(r.get("shared_slots", 1)), 0)
        # 注入位配额（仅在自动注入路径生效；定向/显式查询不受影响）
        self.quota = r.get("quota") or DEFAULT_QUOTA
        # 分组门槛: 分组默认值 + 单类覆盖
        gm = r.get("group_min") or {}
        self.group_min = {**DEFAULT_GROUP_MIN, **gm}
        cm = r.get("cat_min") or {}
        self.cat_min = {**DEFAULT_CAT_MIN, **cm}
        # 兼容旧配置: 单个 group_min_score 作为所有组的兵底
        legacy = r.get("group_min_score")
        self.legacy_min = float(legacy) if legacy is not None else None

    def search(self, query: str, query_vec: np.ndarray,
               source: str | None = None, n: int | None = None,
               namespace: str | None = None) -> list[dict]:
        """返回 [{"id","content","category","source","score","project",...}] 按相关度降序

        `namespace`（multi-pi-memory 新增）: 按"人/员工"隔离个人记忆。
        存储上复用 `project` 列承载命名空间。

        隔离规则（三档）:
          - 私有档: project == namespace            —— 本岗位的领域积累，只有自己可见；
          - 共享档: project == shared_namespace     —— 用户画像 / 环境事实，所有员工可见；
          - 知识库: source == knowledge             —— 团队文档资产，对所有 namespace 可见，
            不该按人复制一份;
          - namespace 为空(未分人/历史数据) 时退化为原行为(全局可见)。
        """
        top_n = n or self.top_n
        meta, matrix = store.load_embeddings()
        if not meta or query_vec.size == 0:
            return []

        scores = store.cosine_similarity(query_vec, matrix)
        if source:
            keep = [i for i, m in enumerate(meta) if m["source"] == source]
        else:
            keep = list(range(len(meta)))

        scoped = bool(namespace)
        if scoped:
            shared = self.shared_ns
            keep = [i for i in keep
                    if (meta[i].get("project") or "") == namespace
                    or (shared and (meta[i].get("project") or "") == shared)
                    or (meta[i].get("source") or "") == "knowledge"]
        if not keep:
            return []
        keep = np.array(keep)

        def build(i: int) -> dict:
            """把一条记忆包装成检索结果（含关键词加成后的 final_score）"""
            m = meta[i]
            score = float(scores[i])
            kw = _keyword_hit(query, m["content"], m["category"])
            return {**m, "score": round(score, 4),
                    "boost": round(kw * self.keyword_boost * 5, 4),
                    "final_score": round(score + kw * self.keyword_boost * 5, 4)}

        # 自动注入路径：调用方既没指定 source、也没指定条数 n，说明这是
        # 系统自动拼给 agent 的上下文 —— 走分库配额。反之，指定 source
        # （定向查询）或 n（显式要固定条数，如 /search 的 8 条）说明调用者
        # 有明确意图，保持纯相关度排序。
        if source is None and n is None and self.quota:
            return self._quota_search(meta, keep, scores, build, top_n, scoped)

        cand = max(min(self.k_candidates, len(keep)), 1)
        idx = keep[np.argsort(-scores[keep])[:cand]]

        results = []
        for i in idx:
            r = build(int(i))
            if r["final_score"] < self.min_score:
                continue
            results.append(r)

        # 断崖检测: 若 top1 明显高于后续, 只保留头部
        if len(results) >= 3:
            top1, top3 = results[0]["final_score"], results[2]["final_score"]
            if top3 > 0 and top1 / top3 > self.cliff_ratio:
                results = results[:3]
            elif top1 / max(top3, 1e-6) > self.cliff_ratio * 1.5:
                results = results[:2]

        return self._dedupe_content(results)[:top_n]

    @staticmethod
    def _dedupe_content(results: list[dict]) -> list[dict]:
        """同文去重（保留分数最高的那份）。

        同一句内容可能同时存在两份: 共享档一份 + 某员工私有档一份
        （把老库记忆复制到某个 waker id 名下就会这样）。两份都过可见性过滤、
        又都进候选时，会白占一个注入位 —— 实测「内容发布标准」这一问
        5 个名额里被重复吃掉了 2 个。按内容去重，命中重复就丢弃后来者。
        """
        out: list[dict] = []
        seen: set[str] = set()
        for r in results:
            key = (r.get("content") or "").strip()
            if key:
                if key in seen:
                    continue
                seen.add(key)
            out.append(r)
        return out

    def _quota_search(self, meta, keep, scores, build, top_n: int, scoped: bool) -> list[dict]:
        """分库独立检索 + 配额：每类各自排序、各自取名次，互不挤占。

        为什么必须"各库独立"而不是"全库排序后分组"：
        内容型记忆（evidence 807 + thesis 96）占 59%，文本是论述性的、
        与提问天然更相似，会把全库候选池（k_candidates=30）占满 ——
        用户档案即使相关也进不来。实测「帮我写一篇关于一人公司的文章」
        时 profile 一条都没进全库前 30，配额形同虚设。
        各库独立排序后，索引空间互不干扰，配额才真正成立。

        `scoped` 为真（即带着 namespace 检索）时，先给共享档预留名额。
        """
        picked: list[dict] = []
        used: set[int] = set()
        seen_content: set[str] = set()

        def accept(idx: int, r: dict) -> bool:
            """收录一条；同文只留分数最高的那次（共享档与私有档可能各存一份）。"""
            key = (r.get("content") or "").strip()
            if key and key in seen_content:
                return False
            if key:
                seen_content.add(key)
            picked.append(r)
            used.add(idx)
            return True

        # 0) 共享档预留位：跨 bot 的用户画像 / 环境事实优先占位。
        #    不预留就会被最后一步的 top_n 截断吃掉 —— 共享条目多是无归属的短事实，
        #    分数通常拼不过本岗位的长论述。
        if scoped and self.shared_ns and self.shared_slots:
            skeep = np.array([i for i in keep if (meta[i].get("project") or "") == self.shared_ns])
            if skeep.size:
                for i in skeep[np.argsort(-scores[skeep])[: self.shared_slots]]:
                    r = build(int(i))
                    if r["final_score"] < self._min_for(r["category"], _group_of(r["category"])):
                        continue
                    accept(int(i), r)

        for group, limit in self.quota.items():
            limit = max(int(limit), 0)
            if not limit:
                continue
            # 共享档已占掉的同类名额要从额度里扣，否则总分超 top_n、共享条目反被挤出
            limit = max(limit - sum(1 for r in picked if _group_of(r["category"]) == group), 0)
            if not limit:
                continue
            # 必须排掉 used：共享档预留位可能正好落在本组，不排除会重复注入同一条
            gkeep = np.array([i for i in keep
                              if _group_of(meta[i]["category"]) == group and int(i) not in used])
            if gkeep.size == 0:
                continue
            taken = 0
            for i in gkeep[np.argsort(-scores[gkeep])]:
                if taken >= limit:
                    break
                r = build(int(i))
                if r["final_score"] < self._min_for(r["category"], group):
                    continue          # 该库内没有够格的，把名额让给别的库
                # 同文被跳过时**不占名额**，名额顺延给下一条（否则重复会白吃一个位）
                if accept(int(i), r):
                    taken += 1

        # 某库候选不足（或都不过门槛）→ 空出的名额全库按分数补齐。
        # 注意: 这里必须用各类自己的门槛(_min_for), 不能用全局 min_score。
        # 用全局时会漏 —— 实测「今天天气怎么样」这类无关提问下, 配额只
        # 捞到 1 条 preference, 剩下 4 个名额被这里的 0.5 门槛放进来一堆
        # 噪声(evidence 0.517、fact 0.523), 把刚抬高的门槛全白费了。
        if len(picked) < top_n:
            rest = np.array([i for i in keep if int(i) not in used])
            if rest.size:
                for i in rest[np.argsort(-scores[rest])[:top_n * 4]]:
                    r = build(int(i))
                    g = _group_of(r["category"])
                    if r["final_score"] < self._min_for(r["category"], g):
                        continue
                    accept(int(i), r)
                    if len(picked) >= top_n:
                        break

        picked.sort(key=lambda r: -r["final_score"])
        # 再兜一次：断崖/配额之外仍可能有同文（保底，幂等）
        return self._dedupe_content(picked)[:top_n]

    def _min_for(self, category: str, group: str) -> float:
        """取某个类别的召回门槛。优先级: 单类微调 > 分组默认 > 旧配置兼容 > 全局"""
        if category in self.cat_min:
            return float(self.cat_min[category])
        if group in self.group_min:
            return float(self.group_min[group])
        if self.legacy_min is not None:
            return self.legacy_min
        return self.min_score

    def build_inject_context(self, results: list[dict]) -> str:
        """把检索结果拼成注入 system prompt 的文本"""
        if not results:
            return ""
        labels = {"fact": "事实", "preference": "偏好", "goal": "目标",
                  "decision": "决定", "knowledge": "知识"}
        lines = ["关于用户或任务的已知信息（来自跨会话记忆/知识库，供参考）："]
        for r in results:
            label = labels.get(r["category"], r["category"])
            src = "知识库" if r["source"] == "knowledge" else "记忆"
            lines.append(f"- [{label}][{src}] {r['content']}")
        return "\n".join(lines)
