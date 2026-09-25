/*
 * Code2Doc call-graph viewer.
 *
 * Reads window.CODE2DOC_GRAPH (set by graph_data.js, loaded via <script src>
 * rather than fetch so the page works from file://) and renders an interactive
 * directed call graph with a documentation inspector.
 */
(function () {
  'use strict';

  var data = window.CODE2DOC_GRAPH;
  var POLICY = window.CODE2DOC_POLICY;
  var cy = null;
  var byId = Object.create(null);
  var selectedId = null;

  // Adjacency, built once from the integer-interned edge list.
  var outAdj = Object.create(null);
  var inAdj = Object.create(null);

  // Which nodes are currently on the canvas. The view is a depth- and
  // breadth-limited tree grown from the entrypoints by graph_policy.js: without
  // a limit, rendering everything produces an illegible hairball (measured:
  // 1,365 nodes takes ~16 s and shows no structure) and even a 58-node program
  // graph opens as a wall of leaf calls.
  var visible = Object.create(null);
  var visibleCount = 0;
  var nodeDepth = Object.create(null);
  var budgetHit = false;

  // topo is the policy's view of the graph: ids, callee lists, names, roots.
  var topo = null;
  var policy = { depth: 3, children: 5, budget: 300 };

  // What the user has done on top of the policy. expanded/collapsed are per
  // node; pinned holds nodes reached by name rather than by expansion.
  var expandedNodes = Object.create(null);
  var collapsedNodes = Object.create(null);
  var pinnedNodes = Object.create(null);

  var el = {
    cy: document.getElementById('cy'),
    title: document.getElementById('title'),
    stats: document.getElementById('stats'),
    search: document.getElementById('search'),
    searchStatus: document.getElementById('search-status'),
    empty: document.getElementById('empty-state'),
    drawer: document.getElementById('drawer'),
    drawerName: document.getElementById('drawer-name'),
    drawerSub: document.getElementById('drawer-sub'),
    drawerBody: document.getElementById('drawer-body'),
    drawerClose: document.getElementById('drawer-close'),
    fit: document.getElementById('btn-fit'),
    relayout: document.getElementById('btn-relayout'),
    orient: document.getElementById('btn-orient'),
    reset: document.getElementById('btn-reset'),
    nodeControls: document.getElementById('node-controls'),
    expand: document.getElementById('btn-expand'),
    collapse: document.getElementById('btn-collapse'),
    refine: document.getElementById('btn-refine'),
    legendRefined: document.getElementById('legend-refined'),
    depth: document.getElementById('ctl-depth'),
    children: document.getElementById('ctl-children'),
    entrypoints: document.getElementById('entrypoints')
  };

  function fail(message) {
    el.empty.style.display = 'flex';
    el.empty.textContent = message;
  }

  /* -- rendering ---------------------------------------------------------- */

  // Roots are held in meta rather than recomputed, so the builder stays the
  // single source of truth for what counts as an entrypoint.
  function roleOf(node, rootSet) {
    if (rootSet[node.id]) return 'root';
    return node.kind === 'external' ? 'external' : 'documented';
  }

  var rootSet = Object.create(null);

  function buildIndex() {
    (data.meta.roots || []).forEach(function (id) { rootSet[id] = true; });
    data.nodes.forEach(function (n) {
      byId[n.id] = n;
      outAdj[n.id] = [];
      inAdj[n.id] = [];
    });
    // Edges arrive as [sourceIndex, targetIndex] pairs into data.nodes.
    data.edges.forEach(function (pair) {
      var s = data.nodes[pair[0]], t = data.nodes[pair[1]];
      if (!s || !t) return;
      outAdj[s.id].push(t.id);
      inAdj[t.id].push(s.id);
    });

    var names = Object.create(null);
    data.nodes.forEach(function (n) { names[n.id] = n.name; });
    topo = {
      ids: data.nodes.map(function (n) { return n.id; }),
      out: outAdj,
      name: names,
      roots: effectiveRoots()
    };
  }

  // meta.roots is the builder's answer and is preferred. A corpus with no
  // in-degree-0 function at all would otherwise render nothing, so fall back to
  // the widest callers -- the same fallback the old seeding used.
  function effectiveRoots() {
    var roots = (data.meta.roots || []).filter(function (id) { return byId[id]; });
    if (roots.length) return roots;
    return data.nodes.slice()
      .sort(function (a, b) { return b.out_degree - a.out_degree; })
      .slice(0, 2)
      .map(function (n) { return n.id; });
  }

  // Counted over callees only, because callees are what expanding reveals. A
  // badge promising more than a click delivers is worse than no badge.
  function hiddenChildCount(id) {
    return POLICY.hiddenChildCount(id, topo, visible);
  }

  function visibleChildCount(id) {
    return POLICY.visibleChildCount(id, topo, visible);
  }

  function labelFor(id) {
    var hidden = hiddenChildCount(id);
    // An explicit "+N" beats inventing a new visual language for "has more".
    return hidden ? byId[id].name + '  +' + hidden : byId[id].name;
  }

  // Recompute the drawn set from the policy plus the user's expansions,
  // collapses and pins. Every view change goes through here, so the canvas is
  // always exactly what the current settings describe -- there is no
  // incremental state to drift out of step.
  function recompute() {
    var result = POLICY.compute(topo, policy, {
      expanded: expandedNodes,
      collapsed: collapsedNodes,
      pinned: pinnedNodes
    });
    visible = result.visible;
    nodeDepth = result.depth;
    visibleCount = result.order.length;
    budgetHit = result.budgetHit;
  }

  // Back to the policy's own view: drop every manual expansion, collapse and
  // pin.
  function resetView() {
    expandedNodes = Object.create(null);
    collapsedNodes = Object.create(null);
    pinnedNodes = Object.create(null);
    recompute();
  }

  function buildElements() {
    var elements = [];
    Object.keys(visible).forEach(function (id) {
      var n = byId[id];
      elements.push({
        data: {
          id: id,
          label: labelFor(id),
          role: roleOf(n, rootSet),
          depth: nodeDepth[id] == null ? 0 : nodeDepth[id],
          expandable: hiddenChildCount(id) > 0 ? 1 : 0,
          collapsed: collapsedNodes[id] ? 1 : 0,
          refined: getRefined(id) ? 1 : 0
        }
      });
    });
    data.edges.forEach(function (pair, i) {
      var s = data.nodes[pair[0]], t = data.nodes[pair[1]];
      if (!s || !t || !visible[s.id] || !visible[t.id]) return;
      elements.push({ data: { id: 'e' + i, source: s.id, target: t.id } });
    });
    return elements;
  }

  // Rebuild the canvas from the current visible set. Cheap enough at these
  // sizes that incremental add/remove bookkeeping is not worth the complexity.
  function rerender(preserveSelection) {
    var keep = preserveSelection ? selectedId : null;
    cy.elements().remove();
    cy.add(buildElements());
    layout();
    updateStats();
    if (keep && visible[keep]) highlight(keep);
    // Counts change with every rerender, and a policy change can drop the
    // selected node off the canvas altogether.
    refreshNodeControls();
  }

  function expandNode(id) {
    if (hiddenChildCount(id) === 0) return 0;
    var before = visibleCount;
    delete collapsedNodes[id];
    expandedNodes[id] = true;
    recompute();
    rerender(true);
    return visibleCount - before;
  }

  function collapseNode(id) {
    if (visibleChildCount(id) === 0) return 0;
    var before = visibleCount;
    delete expandedNodes[id];
    collapsedNodes[id] = true;
    recompute();
    rerender(true);
    return before - visibleCount;
  }

  // One gesture for both: a node with undrawn callees opens, a node whose
  // callees are all drawn folds them away.
  function toggleNode(id) {
    if (hiddenChildCount(id) > 0) return expandNode(id);
    return -collapseNode(id);
  }

  function updateStats() {
    var m = data.meta || {};
    var shown = visibleCount < data.nodes.length
      ? visibleCount + ' of ' + m.node_count + ' shown · '
      : '';
    var capped = budgetHit ? ' · view limit ' + policy.budget + ' reached' : '';
    var refined = refinedCount();
    var refinedText = refined ? ' · ' + refined + ' refined' : '';
    el.stats.textContent = shown + m.node_count + ' functions · ' +
      m.edge_count + ' calls · ' + m.documented + ' documented' + capped + refinedText;
  }

  var STYLE = [
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        'font-size': 11,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'ellipsis',
        'text-max-width': 150,
        'width': 'label',
        'height': 24,
        'padding': '8px',
        'shape': 'round-rectangle',
        'border-width': 1.5,
        'background-color': css('--bg'),
        'border-color': css('--border'),
        'color': css('--fg')
      }
    },
    {
      selector: 'node[role = "documented"]',
      style: { 'background-color': css('--accent-soft'), 'border-color': css('--accent') }
    },
    {
      selector: 'node[role = "root"]',
      style: {
        'background-color': css('--root-soft'),
        'border-color': css('--root'),
        'border-width': 2.5,
        'font-weight': 'bold'
      }
    },
    {
      selector: 'node[role = "external"]',
      style: {
        'background-color': 'transparent',
        'border-color': css('--external'),
        'border-style': 'dashed',
        'color': css('--fg-muted')
      }
    },
    {
      selector: 'edge',
      style: {
        'width': 1.2,
        'line-color': css('--border'),
        'target-arrow-color': css('--border'),
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.85,
        'curve-style': 'bezier'
      }
    },
    {
      selector: 'node[expandable = 1]',
      style: { 'border-style': 'double', 'border-width': 3 }
    },
    {
      // Deliberately folded, as against merely having more to show. Without
      // this a collapsed entrypoint -- which takes the whole graph with it --
      // is indistinguishable from a viewer that has broken.
      selector: 'node[collapsed = 1]',
      style: { 'border-style': 'dotted', 'border-width': 3.5, 'background-opacity': 0.5 }
    },
    {
      // A refinement run covers this function. Only the border colour changes,
      // so the marker composes with the role fill and with the double and
      // dotted borders the view policy draws.
      selector: 'node[refined = 1]',
      style: { 'border-color': css('--refined') }
    },
    {
      selector: 'node.selected',
      style: { 'border-color': css('--accent'), 'border-width': 3.5 }
    },
    {
      selector: '.faded',
      style: { 'opacity': 0.18, 'text-opacity': 0.18 }
    },
    {
      selector: 'edge.incident',
      style: { 'line-color': css('--accent'), 'target-arrow-color': css('--accent'), 'width': 2.2 }
    },
    {
      selector: 'node.search-hit',
      style: { 'border-color': css('--root'), 'border-width': 3 }
    }
  ];

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Left-to-right by default: call depth grows rightward, breadth downward.
  // Call trees are typically shallow and very wide, and top-down turns that
  // into an unreadable horizontal band. A narrow, deep slice of the graph reads
  // better top-down though, so the direction is a toggle rather than a
  // constant. The separations differ per direction because node boxes are wide
  // and short: the gap along the rank axis carries the arrows, the gap across
  // it has to clear the labels.
  var ORIENTATIONS = {
    LR: { nodeSep: 14, rankSep: 110, label: 'Horizontal \u21c4', next: 'TB' },
    TB: { nodeSep: 26, rankSep: 70,  label: 'Vertical \u21c5',   next: 'LR' }
  };
  var rankDir = 'LR';

  function layoutOptions() {
    var o = ORIENTATIONS[rankDir];
    return {
      name: 'dagre',
      rankDir: rankDir,
      nodeSep: o.nodeSep,
      rankSep: o.rankSep,
      edgeSep: 8,
      animate: false,
      fit: true,
      padding: 30
    };
  }

  // Below this, labels stop being legible; better to open at a readable zoom
  // and let the user pan than to fit an unreadable whole.
  var MIN_READABLE_ZOOM = 0.62;

  function layout() {
    cy.layout(layoutOptions()).run();
    clampZoom();
  }

  // The button names the orientation currently in force; its tooltip names the
  // one a click would switch to.
  function setOrientation(dir) {
    rankDir = ORIENTATIONS[dir] ? dir : 'LR';
    if (el.orient) {
      el.orient.textContent = ORIENTATIONS[rankDir].label;
      el.orient.title = 'Switch to a ' +
        (rankDir === 'LR' ? 'vertical (top-to-bottom)' : 'horizontal (left-to-right)') +
        ' layout';
      el.orient.setAttribute('aria-label', el.orient.title);
    }
    if (cy) layout();
  }

  function clampZoom() {
    if (cy.zoom() >= MIN_READABLE_ZOOM) return;
    cy.zoom(MIN_READABLE_ZOOM);
    var roots = (data.meta.roots || []).map(function (id) { return cy.getElementById(id); })
                                       .filter(function (n) { return n && n.length; });
    cy.center(roots.length ? roots[0] : cy.nodes());
  }

  /* -- inspector ---------------------------------------------------------- */

  function text(s) { return document.createTextNode(s == null ? '' : String(s)); }

  function make(tag, className, content) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (content != null) e.appendChild(text(content));
    return e;
  }

  // Renders blank-line-separated paragraphs. Uses textContent throughout, so
  // generated comment text can never inject markup.
  function prose(str) {
    var wrap = make('div', 'prose');
    String(str).split(/\n{2,}/).forEach(function (p) {
      if (p.trim()) wrap.appendChild(make('p', null, p.trim()));
    });
    return wrap;
  }

  function section(label, node) {
    var s = make('div', 'section');
    s.appendChild(make('div', 'section-label', label));
    s.appendChild(node);
    return s;
  }

  // The comment store is read through this one accessor and nothing else
  // touches it (plan §3.2): when the bodies are sharded, this is the one place
  // that changes. getRefined() below is its sibling for the refinement overlay.
  function getDoc(id) {
    return (data.docs && data.docs[id]) || null;
  }

  // Summary / Description / Parameters / Returns / Notes for one parsed
  // comment. Shared by the inspector's main document and by every rung of the
  // refinement ladder, so the two renderings can never drift apart.
  function docSections(doc) {
    var frag = document.createDocumentFragment();
    if (doc.brief)       frag.appendChild(section('Summary', prose(doc.brief)));
    if (doc.description) frag.appendChild(section('Description', prose(doc.description)));

    if (doc.params && doc.params.length) {
      var dl = document.createElement('dl');
      dl.className = 'params';
      doc.params.forEach(function (p) {
        dl.appendChild(make('dt', null, p[0]));
        dl.appendChild(make('dd', null, p[1] || '—'));
      });
      frag.appendChild(section('Parameters', dl));
    }

    if (doc.returns) frag.appendChild(section('Returns', prose(doc.returns)));

    if (doc.tags && doc.tags.length) {
      var ul = make('ul', 'tags');
      doc.tags.forEach(function (t) {
        var li = make('li', t[0]);
        li.appendChild(make('span', 'tag-name', t[0]));
        li.appendChild(text(t[1] || ''));
        ul.appendChild(li);
      });
      frag.appendChild(section('Notes', ul));
    }
    return frag;
  }

  /* -- refinement --------------------------------------------------------- */

  // The overlay is optional: graph_data.refined.js loads before this script
  // when a build carries one and is silently absent otherwise. Like the docs
  // map, it is read only through the accessors below.
  function overlay() {
    var r = window.CODE2DOC_REFINED;
    return (r && r.docs) ? r : null;
  }

  function getRefined(id) {
    var r = overlay();
    return (r && r.docs[id]) || null;
  }

  function refinedRun(entry) {
    var r = overlay();
    return (r && r.runs && entry && r.runs[entry.run]) || null;
  }

  // Refined functions that this payload actually draws, for the legend and
  // the stats line. The builder already scopes the overlay to the payload, so
  // the filter is a guard against a mismatched pair of files, not the norm.
  function refinedCount() {
    var r = overlay();
    if (!r) return 0;
    return Object.keys(r.docs).filter(function (id) { return !!byId[id]; }).length;
  }

  function fmtCosine(c) { return c == null ? '\u2014' : c.toFixed(2); }

  // The score at iteration n is the similarity of comment n to comment n-1,
  // so it measures stability, not quality. Within the run's threshold is
  // "stable". Iteration 0 has nothing to compare against, and a leaf after
  // iteration 1 is carried forward unchanged, so both are neutral rather
  // than scored.
  function cosineClass(it, entry, run) {
    if (it.cosine == null || it.n === 0) return 'cos-none';
    if (!entry.is_parent && it.n > 1) return 'cos-none';
    if (!run || run.threshold == null) return 'cos-none';
    return (1 - it.cosine) <= run.threshold ? 'cos-stable' : 'cos-changed';
  }

  function cosineTitle(it, cls, run) {
    if (it.n === 0) return 'Baseline: the comment before refinement, not scored';
    var s = 'Cosine similarity to the previous iteration: ' + fmtCosine(it.cosine);
    if (cls === 'cos-stable') s += ' (within threshold ' + run.threshold + ': stable)';
    else if (cls === 'cos-changed') s += ' (beyond threshold ' + run.threshold + ': still changing)';
    else if (it.cosine != null) s += ' (carried forward unchanged)';
    return s;
  }

  function iterationHasContent(it) {
    return !!(it && (it.brief || it.description ||
                     (it.params && it.params.length) || it.returns ||
                     (it.tags && it.tags.length)));
  }

  // The drawer's refinement section: a provenance line, one rung per
  // iteration with its cosine badge, and the selected iteration's comment
  // rendered exactly like the main document. Without overlay data for this
  // function it explains what refinement is and how to produce it.
  function renderRefinement(id) {
    var wrap = make('div', 'section refinement');
    wrap.appendChild(make('div', 'section-label', 'Iterative refinement'));
    var entry = getRefined(id);

    if (!entry) {
      wrap.appendChild(make('div', 'note',
        'No refinement run covers this function. Iterative refinement documents ' +
        'its callees first, feeds their documentation into this function\u2019s ' +
        'prompt, and repeats until the comments stop changing (cosine similarity ' +
        'between iterations within the run\u2019s threshold).'));
      var xmlDir = (data.meta && (data.meta.xml_dir || data.meta.run_dir)) || '<xml-dir>';
      wrap.appendChild(make('pre', 'sig',
        'python3 refine_subtree.py --root ' + id + ' --xml-dir ' + xmlDir));
      wrap.appendChild(make('div', 'note',
        'That driver arrives in Phase 2. Until then a runSummary.py run with ' +
        'func_id set to this refid produces the data, but it starts from the ' +
        'XML\u2019s existing comments, not from the one-shot comment shown above.'));
      return wrap;
    }

    var run = refinedRun(entry) || {};
    var prov = make('p', 'provenance');
    prov.appendChild(make('span', 'badge refined', entry.is_parent ? 'parent' : 'leaf'));
    var bits = [];
    if (run.model) bits.push(run.model);
    if (run.iterations_run != null) {
      bits.push(run.iterations_run + ' of ' +
                (run.iterations_configured != null ? run.iterations_configured : '?') +
                ' iterations');
    }
    if (run.threshold != null) bits.push('threshold ' + run.threshold);
    if (run.converged === true) bits.push('converged');
    else if (run.converged === false) bits.push('not converged');
    if (run.timestamp) bits.push(String(run.timestamp).slice(0, 10));
    prov.appendChild(text(bits.join(' \u00b7 ')));
    if (run.root && byId[run.root]) {
      prov.appendChild(text(' \u00b7 rooted at '));
      var rb = make('button', null, run.root_name || byId[run.root].name);
      rb.type = 'button';
      rb.addEventListener('click', function () { focusNode(run.root); });
      prov.appendChild(rb);
    } else if (run.root_name) {
      prov.appendChild(text(' \u00b7 rooted at ' + run.root_name));
    }
    wrap.appendChild(prov);

    var ladder = make('div', 'ladder');
    ladder.setAttribute('role', 'tablist');
    var stage = make('div', 'stage');
    var rungs = [];

    // Only the stage is swapped when a rung is chosen; the ladder and the
    // rest of the drawer stay put.
    function show(n) {
      rungs.forEach(function (b, i) {
        b.classList.toggle('active', i === n);
        b.setAttribute('aria-selected', i === n ? 'true' : 'false');
      });
      stage.textContent = '';
      var it = entry.iterations[n];
      if (!iterationHasContent(it)) {
        stage.appendChild(make('div', 'note', n === 0
          ? 'No comment existed before refinement.'
          : 'No comment was recorded at this iteration.'));
      } else {
        stage.appendChild(docSections(it));
      }
    }

    entry.iterations.forEach(function (it, i) {
      var b = make('button', 'rung', it.n === 0 ? '0 baseline' : String(it.n));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      var cls = cosineClass(it, entry, run);
      b.title = cosineTitle(it, cls, run);
      b.appendChild(make('span', 'cos ' + cls, fmtCosine(it.cosine)));
      b.addEventListener('click', function () { show(i); });
      rungs.push(b);
      ladder.appendChild(b);
    });
    wrap.appendChild(ladder);
    wrap.appendChild(stage);
    if (!entry.is_parent) {
      wrap.appendChild(make('div', 'note',
        'Leaf function: regenerated once at iteration 1, then carried forward unchanged.'));
    }
    show(Math.max(0, Math.min(entry.final, entry.iterations.length - 1)));
    return wrap;
  }

  function openInspector(id) {
    var node = byId[id];
    if (!node) return;
    selectedId = id;

    var doc = getDoc(id);
    var isRoot = (data.meta.roots || []).indexOf(id) !== -1;

    el.drawerName.textContent = node.qualified_name || node.name;

    // Subtitle: badges plus origin (source file or owning namespace/class).
    el.drawerSub.textContent = '';
    if (isRoot) el.drawerSub.appendChild(make('span', 'badge root', 'entrypoint'));
    el.drawerSub.appendChild(
      make('span', 'badge ' + node.doc_state,
           node.doc_state === 'generated' ? 'generated doc' : 'no doc'));
    if (getRefined(id)) el.drawerSub.appendChild(make('span', 'badge refined', 'refined'));
    if (node.compound) {
      var origin = node.compound_kind === 'file'
        ? node.compound
        : node.compound_kind + ' ' + node.compound;
      el.drawerSub.appendChild(text(origin));
    }

    var body = el.drawerBody;
    body.textContent = '';

    if (node.signature) {
      body.appendChild(make('pre', 'sig', node.signature));
    }

    // Deep link into the Doxygen page, when the tag-file pass resolved one.
    // Placed directly under the signature rather than after the prose: it is a
    // primary action, and generated comments are long enough to push it off
    // the bottom of the drawer.
    if (node.link && node.link.page) {
      var a = document.createElement('a');
      a.className = 'doclink';
      a.href = node.link.page + (node.link.anchor ? '#' + node.link.anchor : '');
      a.target = '_top';
      a.appendChild(text('Open in documentation \u2192'));
      body.appendChild(a);
    }

    if (!doc) {
      body.appendChild(make('div', 'note',
        'This function is referenced by the call graph but was not documented ' +
        'in this run. No generated comment is available for it.'));
    } else {
      body.appendChild(docSections(doc));
    }

    body.appendChild(renderRefinement(id));

    var callees = neighbourList(id, 'outgoing');
    if (callees.length) body.appendChild(section('Calls (' + callees.length + ')', callees.list));
    var callers = neighbourList(id, 'incoming');
    if (callers.length) body.appendChild(section('Called by (' + callers.length + ')', callers.list));

    el.drawer.classList.add('open');
    highlight(id);
    refreshNodeControls();
  }

  /* -- node controls ------------------------------------------------------ */

  function calleeLabel(verb, n, adjective) {
    if (!n) return verb;
    return verb + ' ' + n + (adjective ? ' ' + adjective : '') +
           ' calle' + (n === 1 ? 'e' : 'es');
  }

  // Expand/Collapse act on the selected node, so they exist only while one is
  // selected and drawn. Both stay visible and disable rather than vanish, so
  // the strip keeps its shape as the selection moves between nodes.
  function refreshNodeControls() {
    var bar = el.nodeControls;
    if (!bar) return;
    var id = selectedId;
    if (!id || !visible[id]) { bar.hidden = true; return; }

    var hidden = hiddenChildCount(id);
    var drawn = visibleChildCount(id);
    var calls = (outAdj[id] || []).length;
    el.expand.textContent = calleeLabel('Expand', hidden, 'hidden');
    el.expand.disabled = !hidden;
    el.expand.title = hidden ? 'Draw this function’s hidden callees (or double-click it)'
                    : calls ? 'Every callee is already drawn' : 'This function calls nothing';
    el.collapse.textContent = calleeLabel('Collapse', drawn);
    el.collapse.disabled = !drawn;
    el.collapse.title = drawn ? 'Fold away this function’s drawn callees (or double-click it)'
                      : 'No callees are drawn';
    // Refine names what a click delivers and is never disabled: when no run
    // covers the function, the click explains how to produce one.
    if (el.refine) {
      var entry = getRefined(id);
      if (entry) {
        var run = refinedRun(entry);
        var n = entry.final;
        el.refine.textContent = 'Refined \u00b7 ' + n + (n === 1 ? ' iteration' : ' iterations') +
          (run && run.converged === false ? ' \u00b7 not converged' : '');
        el.refine.title = 'Show how this comment evolved across the refinement run';
      } else {
        el.refine.textContent = 'Refine\u2026';
        el.refine.title = 'No iterative refinement covers this function yet; ' +
                          'shows what it is and how to run one';
      }
      el.refine.disabled = false;
    }
    bar.hidden = false;
    placeNodeControls();
  }

  // Under the Fit button, wherever the top bar's wrapping has put it, but kept
  // clear of the open inspector so the drawer never covers it.
  function placeNodeControls() {
    var bar = el.nodeControls;
    if (!bar || bar.hidden) return;
    var main = bar.offsetParent;
    if (!main) return;
    var mainRect = main.getBoundingClientRect();
    var drawerWidth = el.drawer.classList.contains('open') ? el.drawer.offsetWidth : 0;
    // Three buttons no longer fit beside the open inspector on a narrow
    // window. Bound the strip to the room that is left so it wraps onto a
    // second row instead of sliding under the drawer, which sits above it.
    bar.style.maxWidth = Math.max(120, mainRect.width - drawerWidth - 16) + 'px';
    var left = el.fit.getBoundingClientRect().left - mainRect.left;
    var limit = mainRect.width - bar.offsetWidth - 8 - drawerWidth;
    bar.style.left = Math.max(8, Math.min(left, limit)) + 'px';
  }

  function actOnSelected(action) {
    var id = selectedId;
    if (!id) return;
    action(id);
    // Re-open to refresh the inspector's "(hidden)" markers as well.
    openInspector(id);
  }

  function neighbourList(id, direction) {
    var ids = (direction === 'outgoing' ? outAdj[id] : inAdj[id]) || [];
    var ul = make('ul', 'callee-list');
    var count = 0;
    ids.forEach(function (other) {
      var meta = byId[other];
      if (!meta) return;
      count++;
      var li = document.createElement('li');
      var b = make('button', null,
                   (meta.qualified_name || meta.name) + (visible[other] ? '' : '  (hidden)'));
      b.addEventListener('click', function () { focusNode(other); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    return { length: count, list: ul };
  }

  // Bring a node onto the canvas if it is not already there, then centre and
  // inspect it. This is what makes search work over the whole payload rather
  // than only over what happens to be drawn.
  function focusNode(id) {
    if (!byId[id]) return;
    if (!visible[id]) {
      // Pin it: the policy keeps it drawn from now on, wherever it sits
      // relative to the entrypoint trees, until the view is reset.
      pinnedNodes[id] = true;
      recompute();
      rerender(false);
    }
    var n = cy.getElementById(id);
    if (n && n.length) cy.animate({ center: { eles: n }, duration: 220 });
    openInspector(id);
  }

  function closeInspector() {
    selectedId = null;
    el.drawer.classList.remove('open');
    cy.elements().removeClass('faded selected incident');
    refreshNodeControls();
  }

  function highlight(id) {
    var n = cy.getElementById(id);
    var keep = n.closedNeighborhood();
    cy.elements().addClass('faded');
    keep.removeClass('faded');
    cy.nodes().removeClass('selected');
    n.addClass('selected');
    cy.edges().removeClass('incident');
    n.connectedEdges().addClass('incident').removeClass('faded');
  }

  /* -- search ------------------------------------------------------------- */

  function runSearch(query) {
    var q = query.trim().toLowerCase();
    cy.nodes().removeClass('search-hit');
    if (!q) {
      el.searchStatus.textContent = '';
      return;
    }
    var hits = data.nodes.filter(function (n) {
      return (n.name && n.name.toLowerCase().indexOf(q) !== -1) ||
             (n.qualified_name && n.qualified_name.toLowerCase().indexOf(q) !== -1);
    });
    el.searchStatus.textContent = hits.length + (hits.length === 1 ? ' match' : ' matches');
    hits.forEach(function (n) {
      var e = cy.getElementById(n.id);
      if (e && e.length) e.addClass('search-hit');
    });
    var offCanvas = hits.filter(function (n) { return !visible[n.id]; }).length;
    if (offCanvas) {
      el.searchStatus.textContent += ' (' + offCanvas + ' not shown)';
    }
    if (hits.length === 1) {
      focusNode(hits[0].id);
    } else if (hits.length) {
      var onCanvas = hits.filter(function (n) { return visible[n.id]; });
      var target = (onCanvas[0] || hits[0]).id;
      if (!visible[target]) focusNode(target);
      else cy.animate({ center: { eles: cy.getElementById(target) },
                        zoom: Math.max(cy.zoom(), 0.9) }, { duration: 250 });
    }
  }

  function applyHash() {
    var m = /(?:^|[#&])fn=([^&]+)/.exec(window.location.hash || '');
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    if (!byId[id]) {
      // Also accept a bare function name, which is friendlier to hand-written links.
      var hit = data.nodes.filter(function (n) { return n.name === id; });
      if (hit.length !== 1) return;
      id = hit[0].id;
    }
    var n = cy.getElementById(id);
    if (n && n.length) cy.center(n);
    openInspector(id);
  }

  /* -- view controls ------------------------------------------------------ */

  // Changing a limit re-derives the whole view. Manual expansions and collapses
  // are kept: they are statements about particular nodes, not about the limits,
  // and discarding them on every keystroke would make the controls hostile to
  // explore with.
  function bindPolicyControl(input, key) {
    if (!input) return;
    input.value = policy[key];
    input.addEventListener('change', function () {
      var next = parseInt(input.value, 10);
      if (isNaN(next)) { input.value = policy[key]; return; }
      policy[key] = next;
      recompute();
      // Reflect any clamping the policy applied, so the box never shows a
      // number the view is not honouring.
      input.value = POLICY.compute(topo, policy, {
        expanded: expandedNodes, collapsed: collapsedNodes, pinned: pinnedNodes
      }).policy[key];
      policy[key] = parseInt(input.value, 10);
      rerender(true);
    });
  }

  /* -- boot --------------------------------------------------------------- */

  function init() {
    if (!data || !data.nodes) {
      fail('graph_data.js was not loaded, or contains no nodes.');
      return;
    }
    if (typeof cytoscape !== 'function') {
      fail('Cytoscape failed to load. Check that vendor/ sits next to viewer.html.');
      return;
    }
    if (!POLICY) {
      fail('graph_policy.js failed to load. Check that it sits next to viewer.html.');
      return;
    }
    if (window.cytoscapeDagre) cytoscape.use(window.cytoscapeDagre);

    el.title.textContent = (data.meta && data.meta.title) || 'Call Graph';
    document.title = el.title.textContent + ' — Code2Doc';


    buildIndex();
    policy.depth = POLICY.DEFAULTS.depth;
    policy.children = POLICY.DEFAULTS.children;
    policy.budget = POLICY.DEFAULTS.budget;
    recompute();

    cy = cytoscape({
      container: el.cy,
      elements: buildElements(),
      style: STYLE,
      wheelSensitivity: 0.25,
      minZoom: 0.08,
      maxZoom: 3
    });

    layout();
    updateStats();

    cy.on('tap', 'node', function (evt) { openInspector(evt.target.id()); });
    cy.on('dbltap', 'node', function (evt) { toggleNode(evt.target.id()); });
    cy.on('tap', function (evt) { if (evt.target === cy) closeInspector(); });

    el.drawerClose.addEventListener('click', closeInspector);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeInspector();
      // "/" focuses search, unless the user is already typing somewhere.
      if (e.key === '/' && document.activeElement !== el.search) {
        e.preventDefault();
        el.search.focus();
      }
    });

    // Deep link INTO the graph: viewer.html#fn=<refid> opens that node's
    // inspector on load. Lets a Doxygen page link back to the call graph, and
    // makes the drawer reachable without a pointer.
    applyHash();
    window.addEventListener('hashchange', applyHash);

    var timer = null;
    el.search.addEventListener('input', function () {
      clearTimeout(timer);
      var v = el.search.value;
      timer = setTimeout(function () { runSearch(v); }, 140);
    });

    // Deliberately no clampZoom on completion. The clamp keeps an *automatic*
    // layout from opening at an unreadable zoom, but Fit is an explicit request
    // to see the whole graph: re-clamping it snapped the view straight back to
    // the seeded window (measured: fit reaches 0.326, the clamp forced 0.620),
    // which made the button look broken.
    el.fit.addEventListener('click', function () {
      cy.animate({ fit: { padding: 30 } }, { duration: 220 });
    });
    el.relayout.addEventListener('click', layout);
    if (el.nodeControls) {
      el.expand.addEventListener('click', function () { actOnSelected(expandNode); });
      el.collapse.addEventListener('click', function () { actOnSelected(collapseNode); });
      if (el.refine) {
        el.refine.addEventListener('click', function () {
          var id = selectedId;
          if (!id) return;
          openInspector(id);
          var sec = el.drawerBody.querySelector('.refinement');
          if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'start' });
        });
      }
      window.addEventListener('resize', placeNodeControls);
    }
    if (el.legendRefined) el.legendRefined.hidden = refinedCount() === 0;
    if (el.orient) {
      setOrientation(rankDir);
      el.orient.addEventListener('click', function () {
        setOrientation(ORIENTATIONS[rankDir].next);
      });
    }
    // Entrypoint picker: with 45 entrypoints the canvas can only seed a couple,
    // so the rest need to be reachable without knowing their names in advance.
    var roots = data.meta.roots || [];
    if (el.entrypoints && roots.length > 1) {
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = 'Entrypoints (' + roots.length + ')\u2026';
      el.entrypoints.appendChild(ph);
      roots.forEach(function (id) {
        var n = byId[id];
        if (!n) return;
        var o = document.createElement('option');
        o.value = id;
        o.textContent = n.name + '  (' + n.out_degree + ' calls)';
        el.entrypoints.appendChild(o);
      });
      el.entrypoints.hidden = false;
      el.entrypoints.addEventListener('change', function () {
        if (this.value) focusNode(this.value);
        this.selectedIndex = 0;
      });
    }

    if (el.reset) {
      el.reset.addEventListener('click', function () {
        closeInspector();
        resetView();
        rerender(false);
      });
      // Always meaningful now: every view is a policy view that the user can
      // have expanded, collapsed or pinned their way out of.
      el.reset.hidden = false;
    }

    bindPolicyControl(el.depth, 'depth');
    bindPolicyControl(el.children, 'children');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
