/*
 * Code2Doc call-graph view policy.
 *
 * Decides which nodes are drawn: a depth- and breadth-limited tree grown from
 * the graph's entrypoints, plus whatever the user has explicitly expanded,
 * collapsed or pinned.
 *
 * Deliberately free of DOM and Cytoscape references so it can be exercised on
 * its own -- the viewer has no test runner, and this is the part with real
 * logic in it. Loads as a browser global (window.CODE2DOC_POLICY) and as a
 * CommonJS module, so a harness can require it without a page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CODE2DOC_POLICY = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // depth 3 / 5 children measured against both shipped corpora: on the outline
  // tutorial it draws 28 of 58 nodes, on SageInterface+SageBuilder 295 of
  // 1,365. budget is the backstop -- a corpus deeper and wider than either
  // cannot flood the canvas, and the viewer says so when it bites.
  var DEFAULTS = { depth: 3, children: 5, budget: 300 };

  function clampInt(value, lo, hi, fallback) {
    var n = parseInt(value, 10);
    if (isNaN(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
  }

  // Children are callees. The policy is a tree over out-edges, so "depth" and
  // "level" mean what they say; callers reach the canvas by other routes
  // (search, a deep link, the drawer's "Called by" list), never by expansion.
  function rankChildren(id, topo) {
    var kids = (topo.out[id] || []).slice();
    // Most structure first: a child that itself calls many functions opens more
    // of the graph than a leaf does, so a capped view keeps the shape of the
    // program rather than an arbitrary five of its calls. Name breaks ties so
    // the same payload always yields the same picture.
    kids.sort(function (a, b) {
      var byFanout = (topo.out[b] || []).length - (topo.out[a] || []).length;
      if (byFanout) return byFanout;
      return String(topo.name[a] || a) < String(topo.name[b] || b) ? -1 : 1;
    });
    return kids;
  }

  /*
   * topo   { ids: [id], out: {id: [id]}, name: {id: string}, roots: [id] }
   * policy { depth, children, budget }  -- any may be absent or out of range
   * state  { expanded: {id:true}, collapsed: {id:true}, pinned: {id:true} }
   *
   * Returns { visible, depth, order, budgetHit, policy }.
   */
  function compute(topo, policy, state) {
    policy = policy || {};
    state = state || {};
    var maxDepth = clampInt(policy.depth, 0, 32, DEFAULTS.depth);
    var maxKids = clampInt(policy.children, 0, 9999, DEFAULTS.children);
    var budget = clampInt(policy.budget, 1, 99999, DEFAULTS.budget);
    var expanded = state.expanded || {};
    var collapsed = state.collapsed || {};
    var pinned = state.pinned || {};

    var known = Object.create(null);
    (topo.ids || []).forEach(function (id) { known[id] = true; });

    var visible = Object.create(null);
    var depth = Object.create(null);
    var order = [];
    var budgetHit = false;

    function add(id, d) {
      if (!known[id]) return false;
      if (visible[id]) {
        if (d < depth[id]) depth[id] = d;   // a shorter route to a drawn node
        return false;
      }
      if (order.length >= budget) { budgetHit = true; return false; }
      visible[id] = true;
      depth[id] = d;
      order.push(id);
      return true;
    }

    var queue = [];
    (topo.roots || []).forEach(function (id) { if (add(id, 0)) queue.push(id); });

    // Pinned nodes are ones the user reached by name -- search, a deep link, a
    // caller list. They frequently belong to no root's tree at all (on the
    // library corpus 69% of nodes are unreachable from any entrypoint by
    // following callees), so they enter as their own shallow roots one level
    // above the limit: you get the node and a single capped level of callees
    // for context, not a whole subtree dropped onto the canvas.
    var pinDepth = Math.max(0, maxDepth - 1);
    Object.keys(pinned).forEach(function (id) { if (add(id, pinDepth)) queue.push(id); });

    while (queue.length) {
      var id = queue.shift();
      if (collapsed[id]) continue;              // user folded this subtree away
      var isOpen = !!expanded[id];
      var d = depth[id];
      // An explicit expansion overrides both limits for that node's own
      // children; their children are governed by the policy again.
      if (d >= maxDepth && !isOpen) continue;
      var kids = rankChildren(id, topo);
      var limit = isOpen ? kids.length : maxKids;
      for (var i = 0; i < kids.length && i < limit; i++) {
        if (add(kids[i], d + 1)) queue.push(kids[i]);
      }
    }

    return {
      visible: visible,
      depth: depth,
      order: order,
      budgetHit: budgetHit,
      policy: { depth: maxDepth, children: maxKids, budget: budget }
    };
  }

  // Callees of `id` that the policy is not currently drawing: what an expand
  // would reveal, and what the "+N" on a node label promises.
  function hiddenChildCount(id, topo, visible) {
    var kids = topo.out[id] || [];
    var n = 0;
    for (var i = 0; i < kids.length; i++) if (!visible[kids[i]]) n++;
    return n;
  }

  // Callees currently drawn: what a collapse would take away.
  function visibleChildCount(id, topo, visible) {
    var kids = topo.out[id] || [];
    var n = 0;
    for (var i = 0; i < kids.length; i++) if (visible[kids[i]]) n++;
    return n;
  }

  return {
    DEFAULTS: DEFAULTS,
    compute: compute,
    rankChildren: rankChildren,
    hiddenChildCount: hiddenChildCount,
    visibleChildCount: visibleChildCount
  };
});
