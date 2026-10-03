import ZEN from './zen.min.js';
import { renderMarkdown } from './markdown.js';
// The one shared alias+passphrase -> keypair derivation (scobru/fid), pinned to a commit so it can't change under us
import { deriveMasterPair } from 'https://cdn.jsdelivr.net/gh/scobru/fid@7887fc3468a77943da8ef18a70c3936d1dc45a2a/identity.js';

// Configuration
const RELAY_URL = 'https://delay.scobrudot.dev/zen';
const RELAY_URLS = ['https://hmhrmqorxhmzaa7exsbkdmelia.srv.us/zen', 'https://delay.scobrudot.dev/zen'];
const DEFAULT_SALT_PREFIX = 'scobru:zen:blog:';
const KNOWN_ALIASES = {
  // Correct scobru public key (OVI...3lNA)
  '0E2ktahyK9Ngm8bocvimGuKnOVIba3lNA7451zGqcfwn1': 'scobru',
  // Variant with swapped l/I for backwards compatibility
  '0E2ktahyK9Ngm8bocvimGuKnOVlba3INA7451zGqcfwn1': 'scobru',
  'scobru': '0E2ktahyK9Ngm8bocvimGuKnOVIba3lNA7451zGqcfwn1'
};

// State
let zen = null;
let currentPair = null;
let currentUsername = null;
let authorPub = null;
let activeAuthorPub = null;
let currentBlogAlias = null;
let postsMap = new Map();
let currentViewPostId = null;
let isPreviewing = false;
let editingPostId = null;

// DOM Elements
const brandLink = document.getElementById('brand-link');
const brandAliasContainer = document.getElementById('brand-alias-container');
const brandAliasLink = document.getElementById('brand-alias-link');
const brandAliasText = document.getElementById('brand-alias-text');
const blogAuthorTag = document.getElementById('blog-author-tag');
const blogAuthorName = document.getElementById('blog-author-name');
const blogAuthorPub = document.getElementById('blog-author-pub');
const authorCopyBtn = document.getElementById('author-copy-btn');
const themeToggleBtn = document.getElementById('theme-toggle');
const themeText = document.getElementById('theme-text');
const loginTriggerBtn = document.getElementById('login-trigger');
const newPostBtn = document.getElementById('new-post-btn');
const authControls = document.getElementById('auth-controls');
const authorBadge = document.getElementById('author-badge');
const copyBlogBtn = document.getElementById('copy-blog-btn');
const logoutBtn = document.getElementById('logout-btn');
const relayStatusDot = document.getElementById('relay-dot');
const relayStatusText = document.getElementById('relay-text');
const footerStatus = document.getElementById('footer-status');

const listView = document.getElementById('list-view');
const singleView = document.getElementById('single-view');
const postsContainer = document.getElementById('posts-container');
const emptyState = document.getElementById('empty-state');
const emptyTitle = document.getElementById('empty-title');
const emptyDesc = document.getElementById('empty-desc');

// Modals
const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const authUser = document.getElementById('auth-user');
const authPass = document.getElementById('auth-pass');
const authAlert = document.getElementById('auth-alert');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authCancelBtn = document.getElementById('auth-cancel-btn');

const editorModal = document.getElementById('editor-modal');
const editorForm = document.getElementById('editor-form');
const editorModalTitle = document.getElementById('editor-modal-title');
const postTitleInput = document.getElementById('post-title');
const postTagsInput = document.getElementById('post-tags');
const postContentInput = document.getElementById('post-content');
const editorPreview = document.getElementById('editor-preview');
const tabWriteBtn = document.getElementById('tab-write');
const tabPreviewBtn = document.getElementById('tab-preview');
const editorCancelBtn = document.getElementById('editor-cancel-btn');
const editorSubmitBtn = document.getElementById('editor-submit-btn');

const toastEl = document.getElementById('toast');

// --- Helper Utilities ---

function showToast(message, duration = 3000) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  setTimeout(() => {
    toastEl.classList.remove('show');
  }, duration);
}

// Split on commas/whitespace, strip leading '#', dedupe (case-insensitive)
function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set();
  const out = [];
  for (const chunk of raw) {
    for (const part of String(chunk).split(/[\s,]+/)) {
      const tag = part.replace(/^#+/, '').trim();
      const key = tag.toLowerCase();
      if (tag && !seen.has(key)) {
        seen.add(key);
        out.push(tag);
      }
    }
  }
  return out;
}

function renderTags(tags) {
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return normalizeTags(tags)
    .map(t => `<span class="tag-chip"><span class="tag-hash">#</span>${esc(t)}</span>`)
    .join('');
}

function formatDate(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  return date.toISOString().slice(0, 10);
}

function getWordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

function getReadingTime(text) {
  const words = getWordCount(text);
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
}

// --- Theme Management ---

function getCurrentTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme, save = false) {
  document.documentElement.setAttribute('data-theme', theme);
  if (save) {
    try {
      localStorage.setItem('theme', theme);
    } catch (e) { }
  }
  if (themeText) {
    themeText.textContent = theme === 'dark' ? '[ light ]' : '[ dark ]';
  }
}

// --- Cryptographic Keypair Derivation ---
// The identity in use is the FID derivation (deriveMasterPair). This PBKDF2 scheme is what smollog used
// before; it is kept only so migratePosts() can find posts published under it.

async function legacyPairFor(username, password) {
  const cleanUser = username.trim().toLowerCase();
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(DEFAULT_SALT_PREFIX + cleanUser),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  const seed = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return await ZEN.pair(null, { seed });
}

// --- Zen Initialization & Relay Connectivity ---

function initZen() {
  try {
    zen = new ZEN({
      peers: RELAY_URLS,
      localStorage: true,
      radisk: false,
      axe: false
    });

    window.zen = zen;

    // Relay status detection
    updateRelayStatus(false);

    zen.on('hi', () => {
      updateRelayStatus(true);
    });

    // Check wire status periodically
    setInterval(() => {
      try {
        const root = zen._graph && zen._graph._;
        const peers = (root && root.opt && root.opt.peers) || {};
        const isConnected = Object.values(peers).some(
          p => p && p.wire && (p.wire.readyState === 1 || p.wire.readyState === undefined)
        );
        updateRelayStatus(isConnected);
      } catch (e) { }
    }, 5000);

  } catch (err) {
    console.error('Failed to initialize Zen:', err);
    updateRelayStatus(false);
  }
}

function updateRelayStatus(online) {
  if (relayStatusDot) {
    if (online) {
      relayStatusDot.classList.add('online');
    } else {
      relayStatusDot.classList.remove('online');
    }
  }
  if (relayStatusText) {
    relayStatusText.textContent = online ? 'online' : 'connecting';
  }
}

// --- Alias Management & Resolution ---

function updateBlogAlias(alias, pub = activeAuthorPub) {
  if (!alias || typeof alias !== 'string') return;
  const cleanAlias = alias.trim();
  if (!cleanAlias) return;

  currentBlogAlias = cleanAlias;

  if (pub) {
    try {
      localStorage.setItem('zen_alias_' + pub, cleanAlias);
      localStorage.setItem('zen_pub_for_alias_' + cleanAlias.toLowerCase(), pub);
    } catch (e) { }
  }

  // Update brand header (shows smollog/alias)
  if (brandAliasContainer && brandAliasText) {
    brandAliasText.textContent = cleanAlias;
    brandAliasContainer.style.display = 'inline-flex';
  }
  if (brandAliasLink && pub) {
    brandAliasLink.setAttribute('href', `/${pub}`);
  }

  // Update author info tag
  if (blogAuthorTag) {
    blogAuthorTag.style.display = 'inline-flex';
    if (blogAuthorName) blogAuthorName.textContent = '@' + cleanAlias;
    if (blogAuthorPub) {
      blogAuthorPub.style.display = 'none';
    }
  }

  // Update document title
  document.title = `smollog / ${cleanAlias}`;
}

function clearBlogAlias() {
  currentBlogAlias = null;
  if (brandAliasContainer) {
    brandAliasContainer.style.display = 'none';
  }
  if (brandAliasText) {
    brandAliasText.textContent = '';
  }
  if (blogAuthorTag) {
    blogAuthorTag.style.display = 'none';
  }
  document.title = 'smollog';
}

function resolvePubFromCandidate(candidate) {
  if (!candidate) return null;
  const clean = candidate.replace(/^~/, '').trim();
  if (clean.length >= 35) {
    return clean;
  }
  const lower = clean.toLowerCase();
  if (KNOWN_ALIASES[lower]) {
    return KNOWN_ALIASES[lower];
  }
  try {
    const cached = localStorage.getItem('zen_pub_for_alias_' + lower);
    if (cached && cached.length >= 35) return cached;
  } catch (e) { }
  return null;
}

function resolveAuthorAlias(pub) {
  if (!pub) {
    clearBlogAlias();
    return;
  }

  // 1. Current authenticated author
  if (currentPair && currentPair.pub === pub && currentUsername) {
    updateBlogAlias(currentUsername, pub);
    return;
  }

  // 2. Known static dictionary
  if (KNOWN_ALIASES[pub]) {
    updateBlogAlias(KNOWN_ALIASES[pub], pub);
    return;
  }

  // 3. LocalStorage cache
  try {
    const cached = localStorage.getItem('zen_alias_' + pub);
    if (cached) {
      updateBlogAlias(cached, pub);
      return;
    }
  } catch (e) { }

  // 4. Temporary placeholder while fetching
  if (brandAliasContainer && brandAliasText) {
    brandAliasText.textContent = `~${pub.slice(0, 8)}...`;
    brandAliasContainer.style.display = 'inline-flex';
  }
  if (brandAliasLink) {
    brandAliasLink.setAttribute('href', `/${pub}`);
  }
  if (blogAuthorTag) {
    blogAuthorTag.style.display = 'inline-flex';
    if (blogAuthorName) blogAuthorName.textContent = `~${pub.slice(0, 8)}...`;
    if (blogAuthorPub) {
      blogAuthorPub.textContent = `(${pub.slice(0, 10)}...)`;
      blogAuthorPub.title = `Pubkey: ${pub}`;
    }
  }

  // 5. Query Zen graph for alias
  if (zen) {
    zen.get('~' + pub).get('alias').on((val) => {
      if (val && typeof val === 'string') {
        updateBlogAlias(val.trim(), pub);
      }
    });

    zen.get('smollog_authors').get(pub).get('alias').on((val) => {
      if (val && typeof val === 'string') {
        updateBlogAlias(val.trim(), pub);
      }
    });
  }
}

// --- Subscription to Author Userspace ---

let activeSubscription = null;

function subscribeToAuthor(candidate) {
  if (!candidate) {
    authorPub = null;
    activeAuthorPub = null;
    localStorage.removeItem('zen_blog_author_pub');
    postsMap.clear();
    clearBlogAlias();
    renderPostsList();
    return;
  }

  // 1. Resolve pubkey from candidate (could be pubkey itself, or alias like 'scobru')
  const resolvedPub = resolvePubFromCandidate(candidate);

  // If candidate was an alias that resolved to a pubkey, immediately set the blog alias
  if (resolvedPub && resolvedPub !== candidate) {
    updateBlogAlias(candidate, resolvedPub);
  }

  const targetPub = resolvedPub || (candidate.length >= 35 ? candidate : null);

  if (targetPub && activeAuthorPub === targetPub && authorPub === targetPub) {
    return;
  }

  authorPub = targetPub;
  activeAuthorPub = targetPub || candidate;
  if (targetPub) {
    localStorage.setItem('zen_blog_author_pub', targetPub);
  }

  // Clear existing items
  postsMap.clear();
  if (targetPub) {
    resolveAuthorAlias(targetPub);
  }
  renderPostsList();

  if (!zen) return;

  // If candidate is an alias not yet in cache/dictionary, query Zen graph
  if (!targetPub && candidate.length < 35) {
    zen.get('smollog_aliases').get(candidate.toLowerCase()).once((foundPub) => {
      if (foundPub && typeof foundPub === 'string' && foundPub.length >= 35) {
        try {
          localStorage.setItem('zen_pub_for_alias_' + candidate.toLowerCase(), foundPub);
          localStorage.setItem('zen_alias_' + foundPub, candidate);
        } catch (e) { }
        subscribeToAuthor(foundPub);
        updateBlogAlias(candidate, foundPub);
      }
    });
    return;
  }

  // Subscribe to author's posts namespace using the resolved public key
  zen.get('~' + targetPub).get('posts').map().on((post, id) => {
    if (!post || post.deleted === true) {
      postsMap.delete(id);
    } else {
      postsMap.set(id, {
        id: post.id || id,
        title: post.title || 'Untitled',
        content: post.content || '',
        tags: Array.isArray(post.tags) ? post.tags : (post.tags ? String(post.tags).split(',').map(t => t.trim()) : []),
        createdAt: post.createdAt || post.date || Date.now(),
        updatedAt: post.updatedAt || post.createdAt || Date.now(),
        authorPub: targetPub,
        authorAlias: post.authorAlias || currentBlogAlias || null
      });

      if (post.authorAlias && !currentBlogAlias) {
        updateBlogAlias(post.authorAlias, targetPub);
      }
    }

    if (currentViewPostId && currentViewPostId === id) {
      renderSinglePost(currentViewPostId);
    } else {
      renderPostsList();
    }
  });

  // Explicitly listen to author's alias
  zen.get('~' + targetPub).get('alias').on((alias) => {
    if (alias && typeof alias === 'string') {
      updateBlogAlias(alias.trim(), targetPub);
    }
  });

  zen.get('smollog_authors').get(targetPub).get('alias').on((alias) => {
    if (alias && typeof alias === 'string') {
      updateBlogAlias(alias.trim(), targetPub);
    }
  });

  // Verify pub registration
  zen.get('~' + targetPub).get('pub').once((val) => {
    if (val) {
      console.log('Author namespace confirmed on relay:', targetPub);
    }
  });
}

// --- CRUD Operations ---

async function createPost(title, content, tags) {
  if (!currentPair) throw new Error('Not authenticated');

  const id = 'post-' + Date.now();
  const tagList = Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : [];
  const postData = {
    id: id,
    title: title.trim(),
    content: content.trim(),
    tags: tagList.join(', '),
    authorAlias: currentUsername || currentBlogAlias || '',
    authorPub: currentPair.pub,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deleted: false
  };

  return new Promise((resolve, reject) => {
    zen.get('~' + currentPair.pub).get('posts').get(id).put(
      postData,
      ack => {
        if (ack && ack.err) {
          reject(new Error(ack.err));
        } else {
          // Immediately update local map for instant feedback
          postsMap.set(id, { ...postData, tags: tagList, authorPub: currentPair.pub });
          renderPostsList();
          resolve(postData);
        }
      },
      { authenticator: currentPair }
    );
  });
}

async function updatePost(id, title, content, tags) {
  if (!currentPair) throw new Error('Not authenticated');

  const existing = postsMap.get(id);
  const tagList = Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : [];
  const postData = {
    id: id,
    title: title.trim(),
    content: content.trim(),
    tags: tagList.join(', '),
    authorAlias: currentUsername || currentBlogAlias || (existing ? existing.authorAlias : ''),
    authorPub: currentPair.pub,
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
    deleted: false
  };

  return new Promise((resolve, reject) => {
    zen.get('~' + currentPair.pub).get('posts').get(id).put(
      postData,
      ack => {
        if (ack && ack.err) {
          reject(new Error(ack.err));
        } else {
          postsMap.set(id, { ...postData, tags: tagList, authorPub: currentPair.pub });
          if (currentViewPostId === id) {
            renderSinglePost(id);
          } else {
            renderPostsList();
          }
          resolve(postData);
        }
      },
      { authenticator: currentPair }
    );
  });
}

async function deletePost(id) {
  if (!currentPair) throw new Error('Not authenticated');

  const confirmDelete = confirm('Sei sicuro di voler eliminare questo articolo?');
  if (!confirmDelete) return;

  const existing = postsMap.get(id);
  const tombstone = {
    id: id,
    deleted: true,
    title: '',
    content: '',
    updatedAt: Date.now()
  };

  return new Promise((resolve, reject) => {
    zen.get('~' + currentPair.pub).get('posts').get(id).put(
      tombstone,
      ack => {
        if (ack && ack.err) {
          reject(new Error(ack.err));
        } else {
          postsMap.delete(id);
          showToast('Articolo eliminato.');
          if (currentViewPostId === id) {
            navigateTo('/');
          } else {
            renderPostsList();
          }
          resolve();
        }
      },
      { authenticator: currentPair }
    );
  });
}

// --- Routing Helpers ---

function getAuthorFromLocation() {
  // Check pathname: e.g. /0E2ktahyK9Ngm8bocvimGuKnOVIba3lNA7451zGqcfwn1
  const pathname = window.location.pathname.replace(/^\/+|\/+$/g, '');
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0) {
    const candidate = segments[0].replace(/^~/, '').trim();
    if (candidate && !candidate.includes('.') && candidate !== 'index.html' && candidate !== 'api') {
      return candidate;
    }
  }

  // Check URL query parameters
  const params = new URLSearchParams(window.location.search);
  const qAuthor = params.get('author');
  if (qAuthor) return qAuthor.replace(/^~/, '').trim();

  // Check Hash format: #/<pub> or #~<pub>
  const hash = window.location.hash.replace(/^#\/?/, '').replace(/^~/, '').trim();
  if (hash && !hash.includes('=') && !hash.includes('&')) {
    return hash;
  }

  return null;
}

function getPostIdFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get('post') || null;
}

function getPostUrl(postId, targetPub = authorPub) {
  const currentPathAuthor = getAuthorFromLocation();
  const base = currentPathAuthor ? `/${currentPathAuthor}` : (currentBlogAlias ? `/${currentBlogAlias}` : (targetPub ? `/${targetPub}` : ''));
  return `${base}?post=${encodeURIComponent(postId)}`;
}

function getHomeUrl(targetPub = authorPub) {
  const currentPathAuthor = getAuthorFromLocation();
  return currentPathAuthor ? `/${currentPathAuthor}` : (currentBlogAlias ? `/${currentBlogAlias}` : (targetPub ? `/${targetPub}` : '/'));
}

// --- Render Views ---

function renderPostsList() {
  if (currentViewPostId) return;

  const posts = Array.from(postsMap.values())
    .filter(p => !p.deleted)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const catalogCountBadge = document.getElementById("catalog-count-badge");
  if (catalogCountBadge) {
    catalogCountBadge.textContent = authorPub ? `${posts.length} ${posts.length === 1 ? "articolo" : "articoli"}` : "Tutti gli articoli";
  }

  if (footerStatus) {
    if (!authorPub) {
      footerStatus.textContent = "blog pronto";
    } else {
      footerStatus.textContent = `${posts.length} ${posts.length === 1 ? "articolo pubblicato" : "articoli pubblicati"}`;
    }
  }

  if (posts.length === 0) {
    postsContainer.innerHTML = '';
    if (!authorPub) {
      if (emptyTitle) emptyTitle.textContent = 'Nessun autore selezionato';
      if (emptyDesc) {
        emptyDesc.innerHTML = 'Accedi con <strong>[ accedi ]</strong> per iniziare a scrivere, oppure visita il blog di un autore.';
      }
    } else {
      const isOwner = currentPair && authorPub === currentPair.pub;
      if (emptyTitle) emptyTitle.textContent = 'Nessun articolo ancora pubblicato';
      if (emptyDesc) {
        emptyDesc.innerHTML = isOwner ? 'Non hai ancora pubblicato articoli. Clicca su <strong>[ + scrivi ]</strong> per pubblicare il tuo primo post!' : 'Questo autore non ha ancora pubblicato articoli.';
      }
    }
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';
  postsContainer.innerHTML = posts.map(post => {
    const isOwner = currentPair && post.authorPub === currentPair.pub;
    const dateStr = formatDate(post.createdAt);
    const readingTime = getReadingTime(post.content);

    // Create excerpt from plain text
    const plain = post.content.replace(/[#*`_~>[\]()]/g, '').slice(0, 160);
    const excerpt = plain.length >= 160 ? plain + '...' : plain;

    const tagsHtml = renderTags(post.tags);

    const ownerControls = isOwner ? `
      <div class="post-actions">
        <button class="bracket-btn nav-pill-btn edit-btn" data-id="${post.id}">[ modifica ]</button>
        <button class="bracket-btn nav-pill-btn btn-danger delete-btn" data-id="${post.id}">[ elimina ]</button>
      </div>
    ` : '';

    const postHref = getPostUrl(post.id, post.authorPub || authorPub);

    return `
      <li class="post-item" id="item-${post.id}">
        <div class="post-meta-row">
          <span>${dateStr} • ${readingTime}</span>
          ${isOwner ? '<span class="status-badge" style="border-color: var(--success-color); color: var(--success-color); background: var(--success-bg);">Autore</span>' : ''}
        </div>
        <h3 class="post-title">
          <a href="${postHref}" data-nav="${post.id}">${post.title}</a>
        </h3>
        <p class="post-excerpt">${excerpt}</p>
        <div class="post-footer-row">
          <div class="post-tags">${tagsHtml}</div>
          ${ownerControls}
        </div>
      </li>
    `;
  }).join('');

  // Attach event listeners for post links & actions
  postsContainer.querySelectorAll('a[data-nav]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const href = el.getAttribute('href');
      navigateTo(href);
    });
  });

  postsContainer.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const postId = btn.getAttribute('data-id');
      openEditModal(postId);
    });
  });

  postsContainer.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const postId = btn.getAttribute('data-id');
      deletePost(postId);
    });
  });
}

function renderSinglePost(postId) {
  const post = postsMap.get(postId);
  const homeHref = getHomeUrl(post?.authorPub || authorPub);

  if (!post || post.deleted) {
    singleView.innerHTML = `
      <div class="empty-state">
        <p>// Post "${postId}" not found or deleted from Zen graph.</p>
        <a href="${homeHref}" class="bracket-btn" id="back-to-list">← [ back to posts ]</a>
      </div>
    `;
    singleView.querySelector('#back-to-list')?.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(homeHref);
    });
    return;
  }

  const isOwner = currentPair && post.authorPub === currentPair.pub;
  const dateStr = formatDate(post.createdAt);
  const updatedStr = post.updatedAt && post.updatedAt !== post.createdAt ? ` • updated ${formatDate(post.updatedAt)}` : '';
  const readingTime = getReadingTime(post.content);
  const renderedContent = renderMarkdown(post.content);

  const tagsHtml = renderTags(post.tags);

  singleView.innerHTML = `
    <div style="margin-bottom: 20px;">
      <a href="${homeHref}" class="bracket-btn" id="back-link">← [ all posts ]</a>
    </div>
    <article class="single-post-article">
      <header class="single-post-header">
        <div class="single-post-meta">
          <span>${dateStr}${updatedStr}</span>
          <span class="meta-sep">•</span>
          <span>${readingTime}</span>
          <span class="meta-sep">•</span>
          ${post.authorAlias || currentBlogAlias ? `<span class="pub-short">@${post.authorAlias || currentBlogAlias}</span>` : ''}
        </div>
        <h1 class="single-post-title">${post.title}</h1>
        <div class="post-footer-row">
          <div class="post-tags">${tagsHtml}</div>
          <div class="post-actions">
            <button class="bracket-btn nav-pill-btn" id="copy-link-btn">[ copia link ]</button>
            ${isOwner ? `
              <button class="bracket-btn nav-pill-btn edit-btn" id="single-edit-btn">[ modifica ]</button>
              <button class="bracket-btn nav-pill-btn btn-danger" id="single-delete-btn">[ elimina ]</button>
            ` : ''}
          </div>
        </div>
      </header>
      <div class="post-content">
        ${renderedContent}
      </div>
    </article>
  `;

  // Attach single view listeners
  singleView.querySelector('#back-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(homeHref);
  });

  singleView.querySelector('#copy-link-btn')?.addEventListener('click', () => {
    const postUrl = `${window.location.origin}${getPostUrl(postId, post.authorPub || authorPub)}`;
    navigator.clipboard.writeText(postUrl);
    showToast('Link dell\'articolo copiato!');
  });

  if (isOwner) {
    singleView.querySelector('#single-edit-btn')?.addEventListener('click', () => {
      openEditModal(postId);
    });
    singleView.querySelector('#single-delete-btn')?.addEventListener('click', () => {
      deletePost(postId);
    });
  }
}

// --- Routing & Navigation ---

function handleRoute() {
  const urlAuthor = getAuthorFromLocation();
  const targetAuthor = urlAuthor || (currentPair ? currentPair.pub : null);

  if (targetAuthor !== activeAuthorPub) {
    subscribeToAuthor(targetAuthor);
  }

  const postId = getPostIdFromLocation();

  if (postId) {
    currentViewPostId = postId;
    listView.style.display = 'none';
    singleView.style.display = 'block';
    renderSinglePost(postId);
    window.scrollTo(0, 0);
  } else {
    currentViewPostId = null;
    listView.style.display = 'block';
    singleView.style.display = 'none';
    renderPostsList();
  }
}

function navigateTo(url) {
  window.history.pushState({}, '', url);
  handleRoute();
}

window.addEventListener('popstate', handleRoute);

// --- Authentication Flow ---

function updateAuthUI() {
  if (currentPair) {
    loginTriggerBtn.style.display = 'none';
    authControls.style.display = 'inline-flex';
    newPostBtn.style.display = 'inline-flex';
    authorBadge.textContent = `@${currentUsername}`;
  } else {
    loginTriggerBtn.style.display = 'inline-flex';
    authControls.style.display = 'none';
    newPostBtn.style.display = 'none';
  }
}

// Copy posts published under the previous identity to the current one, re-signed with the current key.
// Idempotent (ids already present are skipped); the old posts are left where they are.
async function migratePosts(legacy, pair) {
  const readPosts = (pub) => new Promise((resolve) => {
    const posts = new Map();
    setTimeout(() => resolve(posts), 4000);
    const root = zen.get('~' + pub).get('posts');
    root.map().once((post, id) => {
      if (post && typeof post === 'object') posts.set(id, post);
      else if (id) root.get(id).once((full) => full && posts.set(id, full));
    });
  });
  try {
    const [old, cur] = await Promise.all([readPosts(legacy.pub), readPosts(pair.pub)]);
    const todo = [...old].filter(([id, post]) => post.title && post.deleted !== true && !cur.has(id));
    // puts resolve on ack or after 8s, so an unreachable relay can't hang the login
    await Promise.all(todo.map(([id, post]) => new Promise((resolve) => {
      const t = setTimeout(resolve, 8000);
      const { _, ...fields } = post;
      zen.get('~' + pair.pub).get('posts').get(id).put({ ...fields, authorPub: pair.pub }, () => { clearTimeout(t); resolve(); }, { authenticator: pair });
    })));
    if (todo.length) showToast(`${todo.length} post migrati alla nuova identità`, 4000);
  } catch (err) {
    console.warn('Post migration failed:', err);
  }
}

async function handleLogin(username, password) {
  authAlert.style.display = 'none';
  authSubmitBtn.textContent = 'Accesso in corso...';
  authSubmitBtn.disabled = true;

  try {
    const cleanUser = username.trim().toLowerCase();
    const pair = await deriveMasterPair(ZEN, username, password);
    currentPair = pair;
    currentUsername = username;

    // Register identity and alias on graph
    zen.get('~' + pair.pub).get('pub').put(pair.pub, null, { authenticator: pair });
    zen.get('~' + pair.pub).get('alias').put(cleanUser, null, { authenticator: pair });
    zen.get('smollog_aliases').get(cleanUser).put(pair.pub);

    // Save alias mapping in localStorage
    try {
      localStorage.setItem('zen_alias_' + pair.pub, cleanUser);
      localStorage.setItem('zen_pub_for_alias_' + cleanUser, pair.pub);
    } catch (e) { }

    // Store in session storage for refreshing convenience
    sessionStorage.setItem('zen_blog_user', username);
    sessionStorage.setItem('zen_blog_pass', password);

    // Subscribe to own userspace
    subscribeToAuthor(pair.pub);

    // Bring over posts published under the previous (PBKDF2) identity
    migratePosts(await legacyPairFor(username, password), pair);

    // Update route to /<pub>
    const postId = getPostIdFromLocation();
    const newRoute = '/' + pair.pub + (postId ? `?post=${encodeURIComponent(postId)}` : '');
    window.history.pushState({}, '', newRoute);

    updateAuthUI();
    closeAuthModal();
    handleRoute();
    showToast(`Accesso effettuato! Benvenuto, @${username}`, 3500);
  } catch (err) {
    console.error('Authentication error:', err);
    authAlert.textContent = `Auth error: ${err.message}`;
    authAlert.style.display = 'block';
  } finally {
    authSubmitBtn.textContent = 'Accedi';
    authSubmitBtn.disabled = false;
  }
}

function handleLogout() {
  currentPair = null;
  currentUsername = null;
  sessionStorage.removeItem('zen_blog_user');
  sessionStorage.removeItem('zen_blog_pass');
  updateAuthUI();
  subscribeToAuthor(null);
  window.history.pushState({}, '', '/');
  handleRoute();
  showToast('Disconnessione effettuata.');
}

function openAuthModal() {
  authAlert.style.display = 'none';
  authForm.reset();
  authModal.classList.add('is-open');
  authUser.focus();
}

function closeAuthModal() {
  authModal.classList.remove('is-open');
}

// --- Editor Flow ---

function openCreateModal() {
  editingPostId = null;
  editorModalTitle.textContent = '+ Nuovo Articolo';
  editorForm.reset();
  setEditorTab('write');
  editorModal.classList.add('is-open');
  postTitleInput.focus();
}

function openEditModal(postId) {
  const post = postsMap.get(postId);
  if (!post) return;

  editingPostId = postId;
  editorModalTitle.textContent = `Modifica: ${post.title}`;
  postTitleInput.value = post.title || '';
  postTagsInput.value = normalizeTags(post.tags).join(', ');
  postContentInput.value = post.content || '';
  setEditorTab('write');
  editorModal.classList.add('is-open');
  postTitleInput.focus();
}

function closeEditorModal() {
  editorModal.classList.remove('is-open');
}

function setEditorTab(tab) {
  if (tab === 'preview') {
    isPreviewing = true;
    tabPreviewBtn.style.backgroundColor = 'var(--link-hover-bg)';
    tabPreviewBtn.style.color = 'var(--link-hover-color)';
    tabWriteBtn.style.backgroundColor = 'transparent';
    tabWriteBtn.style.color = 'var(--text-color)';
    postContentInput.style.display = 'none';
    editorPreview.style.display = 'block';
    editorPreview.innerHTML = renderMarkdown(postContentInput.value || '*No content to preview*');
  } else {
    isPreviewing = false;
    tabWriteBtn.style.backgroundColor = 'var(--link-hover-bg)';
    tabWriteBtn.style.color = 'var(--link-hover-color)';
    tabPreviewBtn.style.backgroundColor = 'transparent';
    tabPreviewBtn.style.color = 'var(--text-color)';
    postContentInput.style.display = 'block';
    editorPreview.style.display = 'none';
  }
}

// --- Initialization & Event Bindings ---

function setupEventListeners() {
  // Brand navigation
  brandLink?.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(getHomeUrl());
  });

  // Theme toggle
  themeToggleBtn?.addEventListener('click', () => {
    const current = getCurrentTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('theme')) {
      applyTheme(e.matches ? 'dark' : 'light', false);
    }
  });

  // Auth triggers
  loginTriggerBtn?.addEventListener('click', openAuthModal);
  authCancelBtn?.addEventListener('click', closeAuthModal);
  logoutBtn?.addEventListener('click', handleLogout);

  // Copy blog link button
  copyBlogBtn?.addEventListener('click', () => {
    const targetPub = currentPair ? currentPair.pub : authorPub;
    if (targetPub) {
      const url = `${window.location.origin}/${targetPub}`;
      navigator.clipboard.writeText(url);
      showToast('Link del blog copiato!');
    } else {
      showToast('No author URL available.');
    }
  });

  authorCopyBtn?.addEventListener('click', () => {
    const alias = currentBlogAlias;
    const pub = activeAuthorPub || authorPub;
    const link = alias ? `${window.location.origin}/${alias}` : (pub ? `${window.location.origin}/${pub}` : window.location.href);
    navigator.clipboard.writeText(link);
    showToast('Link del blog copiato!');
  });

  authForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = authUser.value.trim();
    const p = authPass.value;
    if (!u || !p) return;
    handleLogin(u, p);
  });

  // Editor triggers
  newPostBtn?.addEventListener('click', openCreateModal);
  editorCancelBtn?.addEventListener('click', closeEditorModal);
  tabWriteBtn?.addEventListener('click', () => setEditorTab('write'));
  tabPreviewBtn?.addEventListener('click', () => setEditorTab('preview'));

  editorForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = postTitleInput.value.trim();
    const content = postContentInput.value.trim();
    const tags = normalizeTags(postTagsInput.value);

    if (!title || !content) {
      alert('Inserisci sia il titolo che il contenuto.');
      return;
    }

    editorSubmitBtn.textContent = 'Salvataggio in corso...';
    editorSubmitBtn.disabled = true;

    try {
      if (editingPostId) {
        await updatePost(editingPostId, title, content, tags);
        showToast('Articolo aggiornato con successo.');
      } else {
        await createPost(title, content, tags);
        showToast('Articolo pubblicato con successo!');
      }
      closeEditorModal();
    } catch (err) {
      console.error('Save post error:', err);
      alert('Failed to save post: ' + err.message);
    } finally {
      editorSubmitBtn.textContent = 'Pubblica articolo';
      editorSubmitBtn.disabled = false;
    }
  });

  // Close modals on clicking backdrop
  [authModal, editorModal].forEach(modal => {
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('is-open');
      }
    });
  });

  // Esc key closes modals
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAuthModal();
      closeEditorModal();
    }
  });
}

// Bootstrap
(async function init() {
  applyTheme(getCurrentTheme(), false);
  setupEventListeners();
  initZen();

  const urlAuthor = getAuthorFromLocation();
  const savedUser = sessionStorage.getItem('zen_blog_user');
  const savedPass = sessionStorage.getItem('zen_blog_pass');

  if (savedUser && savedPass) {
    await handleLogin(savedUser, savedPass);
  } else if (urlAuthor) {
    subscribeToAuthor(urlAuthor);
  } else {
    subscribeToAuthor(null);
  }

  handleRoute();
})();
