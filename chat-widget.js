// AI chat widget (frontend only, template) — shared across all tiers.
// Talks only to this site's own backend at POST /api/chat and
// GET /api/widget-config. The API key never reaches this file or the browser.
//
// Business-specific text (name, phone) is pulled from /api/widget-config at
// load time instead of being hardcoded here, so a new client should only
// ever require changes to business-config.js and .env, not this file.

(function () {
  // Capture this immediately — document.currentScript is only reliable
  // during the script's initial synchronous execution, not inside any
  // later callback (like DOMContentLoaded below).
  var scriptEl = document.currentScript;
  // Stays '' for an all-in-one install (same origin, relative paths —
  // the default, unchanged behavior). For a split-hosting setup (the
  // widget on Shopify/Wix/etc, the backend hosted separately), set:
  //   <script src="chat-widget.js" data-backend="https://your-backend.onrender.com" defer></script>
  var BACKEND_URL = (scriptEl && scriptEl.getAttribute('data-backend')) || '';

  var FALLBACK_NAME = 'us';
  var FALLBACK_PHONE = null;

  document.addEventListener('DOMContentLoaded', function () {
    var launcher = document.createElement('button');
    launcher.className = 'chat-launcher';
    launcher.type = 'button';
    launcher.setAttribute('aria-label', 'Open chat assistant');
    launcher.innerHTML =
      '<i class="fa-solid fa-comment-dots" aria-hidden="true"></i>' +
      '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

    var panel = document.createElement('div');
    panel.className = 'chat-panel';
    panel.innerHTML =
      '<div class="chat-header">' +
        '<div><div class="chat-header-title" id="chat-header-title">Ask us</div>' +
        '<span class="chat-header-sub">Usually replies in a few seconds</span></div>' +
        '<button type="button" class="chat-close" aria-label="Close chat"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>' +
      '</div>' +
      '<div class="chat-messages" id="chat-messages" role="log" aria-live="polite"></div>' +
      '<form class="chat-input-row" id="chat-form">' +
        '<input type="text" id="chat-input" placeholder="Ask about services, pricing, hours…" autocomplete="off" maxlength="1000">' +
        '<button type="submit" aria-label="Send message"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i></button>' +
      '</form>';

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    var headerTitleEl = panel.querySelector('#chat-header-title');
    var messagesEl = panel.querySelector('#chat-messages');
    var form = panel.querySelector('#chat-form');
    var input = panel.querySelector('#chat-input');
    var sendBtn = form.querySelector('button');
    var closeBtn = panel.querySelector('.chat-close');

    var history = [];
    var widgetConfig = { name: FALLBACK_NAME, phone: FALLBACK_PHONE };

    fetch(BACKEND_URL + '/api/widget-config')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.name) {
          widgetConfig = data;
          headerTitleEl.textContent = 'Ask ' + data.name;
        }
      })
      .catch(function () {});

    function addBubble(role, text) {
      var bubble = document.createElement('div');
      bubble.className = 'chat-bubble chat-bubble-' + role;
      bubble.textContent = text;
      messagesEl.appendChild(bubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return bubble;
    }

    function welcomeText() {
      var base = "Hi! I'm the virtual assistant for " + widgetConfig.name + ". Ask me about our services, pricing, or hours.";
      if (widgetConfig.phone) {
        base += ' For an emergency, please call ' + widgetConfig.phone + ' instead.';
      }
      return base;
    }

    function errorText() {
      var base = 'Sorry, something went wrong on our end.';
      if (widgetConfig.phone) {
        base += ' Please call ' + widgetConfig.phone + ' for help.';
      } else {
        base += ' Please try again in a moment.';
      }
      return base;
    }

    function openPanel() {
      panel.classList.add('open');
      launcher.classList.add('open');
      launcher.setAttribute('aria-label', 'Close chat assistant');
      if (!messagesEl.children.length) {
        addBubble('assistant', welcomeText());
      }
      input.focus();
    }

    function closePanel() {
      panel.classList.remove('open');
      launcher.classList.remove('open');
      launcher.setAttribute('aria-label', 'Open chat assistant');
    }

    launcher.addEventListener('click', function () {
      panel.classList.contains('open') ? closePanel() : openPanel();
    });
    closeBtn.addEventListener('click', closePanel);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;

      addBubble('user', text);
      history.push({ role: 'user', content: text });
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;

      var typing = addBubble('assistant', 'Typing…');
      typing.classList.add('chat-bubble-typing');

      fetch(BACKEND_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      })
        .then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok, data: data }; });
        })
        .then(function (result) {
          typing.remove();
          if (!result.ok || !result.data || !result.data.reply) {
            addBubble('error', errorText());
            return;
          }
          addBubble('assistant', result.data.reply);
          history.push({ role: 'assistant', content: result.data.reply });
        })
        .catch(function () {
          typing.remove();
          addBubble('error', "Sorry, I couldn't reach the server. Please check your connection and try again.");
        })
        .finally(function () {
          input.disabled = false;
          sendBtn.disabled = false;
          input.focus();
        });
    });
  });
})();
