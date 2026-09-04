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
  var cy = null;
  var byId = Object.create(null);
  var selectedId = null;

  // Adjacency, built once from the integer-interned edge list.
  var outAdj = Object.create(null);
  var inAdj = Object.create(null);

  // Which nodes are currently on the canvas. Below FULL_RENDER_LIMIT the whole
  // graph is drawn, which keeps small program graphs behaving exactly as
  // before; above it, rendering everything produces an illegible hairball
  // (measured: 1,365 nodes takes ~16 s and shows no structure), so the graph is
  // seeded from its entrypoints and expanded on demand.
  var visible = Object.create(null);
  var visibleCount = 0;
  var FULL_RENDER_LIMIT = 260;
  var SEED_ROOTS = 2;

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
    reset: document.getElementById('btn-reset'),
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
  }

  function hiddenNeighbourCount(id) {
    var n = 0;
    outAdj[id].forEach(function (x) { if (!visible[x]) n++; });
    inAdj[id].forEach(function (x) { if (!visible[x]) n++; });
    return n;
  }

  function labelFor(id) {
    var hidden = hiddenNeighbourCount(id);
    // An explicit "+N" beats inventing a new visual language for "has more".
    return hidden ? byId[id].name + '  +' + hidden : byId[id].name;
  }

  function show(ids) {
    var added = 0;
    ids.forEach(function (id) {
      if (byId[id] && !visible[id]) { visible[id] = true; visibleCount++; added++; }
    });
    return added;
  }

  function seed() {
    visible = Object.create(null);
    visibleCount = 0;
    if (data.nodes.length <= FULL_RENDER_LIMIT) {
      show(data.nodes.map(function (n) { return n.id; }));
      return;
    }
    // meta.roots is pre-sorted by fan-out, so the head is the most substantial
    // set of entrypoints.
    var roots = (data.meta.roots || []).slice(0, SEED_ROOTS);
    if (!roots.length) {
      roots = data.nodes.slice()
        .sort(function (a, b) { return b.out_degree - a.out_degree; })
        .slice(0, SEED_ROOTS).map(function (n) { return n.id; });
    }
    show(roots);
    roots.forEach(function (r) { show(outAdj[r] || []); });
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
          expandable: hiddenNeighbourCount(id) > 0 ? 1 : 0
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
  }

  function expand(id) {
    var before = visibleCount;
    show(outAdj[id] || []);
    show(inAdj[id] || []);
    if (visibleCount === before) return 0;
    rerender(true);
    return visibleCount - before;
  }

  function updateStats() {
    var m = data.meta || {};
    var shown = visibleCount < data.nodes.length
      ? visibleCount + ' of ' + m.node_count + ' shown · '
      : '';
    el.stats.textContent = shown + m.node_count + ' functions · ' +
      m.edge_count + ' calls · ' + m.documented + ' documented';
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

  // Left-to-right: call depth grows rightward, breadth downward. Call trees are
  // typically shallow and very wide, and top-down turns that into an
  // unreadable horizontal band.
  var LAYOUT = {
    name: 'dagre',
    rankDir: 'LR',
    nodeSep: 14,
    rankSep: 110,
    edgeSep: 8,
    animate: false,
    fit: true,
    padding: 30
  };

  // Below this, labels stop being legible; better to open at a readable zoom
  // and let the user pan than to fit an unreadable whole.
  var MIN_READABLE_ZOOM = 0.62;

  function layout() {
    cy.layout(LAYOUT).run();
    clampZoom();
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

  function openInspector(id) {
    var node = byId[id];
    if (!node) return;
    selectedId = id;

    var doc = (data.docs && data.docs[id]) || null;
    var isRoot = (data.meta.roots || []).indexOf(id) !== -1;

    el.drawerName.textContent = node.qualified_name || node.name;

    // Subtitle: badges plus origin (source file or owning namespace/class).
    el.drawerSub.textContent = '';
    if (isRoot) el.drawerSub.appendChild(make('span', 'badge root', 'entrypoint'));
    el.drawerSub.appendChild(
      make('span', 'badge ' + node.doc_state,
           node.doc_state === 'generated' ? 'generated doc' : 'no doc'));
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
      if (doc.brief)       body.appendChild(section('Summary', prose(doc.brief)));
      if (doc.description) body.appendChild(section('Description', prose(doc.description)));

      if (doc.params && doc.params.length) {
        var dl = document.createElement('dl');
        dl.className = 'params';
        doc.params.forEach(function (p) {
          dl.appendChild(make('dt', null, p[0]));
          dl.appendChild(make('dd', null, p[1] || '—'));
        });
        body.appendChild(section('Parameters', dl));
      }

      if (doc.returns) body.appendChild(section('Returns', prose(doc.returns)));

      if (doc.tags && doc.tags.length) {
        var ul = make('ul', 'tags');
        doc.tags.forEach(function (t) {
          var li = make('li', t[0]);
          li.appendChild(make('span', 'tag-name', t[0]));
          li.appendChild(text(t[1] || ''));
          ul.appendChild(li);
        });
        body.appendChild(section('Notes', ul));
      }
    }

    var hidden = hiddenNeighbourCount(id);
    if (hidden) {
      var btn = make('button', 'btn', 'Expand ' + hidden + ' hidden neighbour' +
                                      (hidden === 1 ? '' : 's'));
      btn.type = 'button';
      btn.addEventListener('click', function () {
        expand(id);
        openInspector(id);
      });
      body.appendChild(section('Graph', btn));
    }

    var callees = neighbourList(id, 'outgoing');
    if (callees.length) body.appendChild(section('Calls (' + callees.length + ')', callees.list));
    var callers = neighbourList(id, 'incoming');
    if (callers.length) body.appendChild(section('Called by (' + callers.length + ')', callers.list));

    el.drawer.classList.add('open');
    highlight(id);
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
      show([id]);
      show(outAdj[id] || []);
      show(inAdj[id] || []);
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
    if (window.cytoscapeDagre) cytoscape.use(window.cytoscapeDagre);

    el.title.textContent = (data.meta && data.meta.title) || 'Call Graph';
    document.title = el.title.textContent + ' — Code2Doc';


    buildIndex();
    seed();

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
    cy.on('dbltap', 'node', function (evt) { expand(evt.target.id()); });
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

    el.fit.addEventListener('click', function () {
      cy.animate({ fit: { padding: 30 } }, { duration: 220, complete: clampZoom });
    });
    el.relayout.addEventListener('click', layout);
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
        seed();
        rerender(false);
      });
      // Only meaningful when the graph is actually being seeded.
      el.reset.hidden = data.nodes.length <= FULL_RENDER_LIMIT;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
