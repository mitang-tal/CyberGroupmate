(function() {
  // Wait for the DOM to be ready
  function addExecutionRecordsNav() {
    // Try to find the sidebar navigation
    // Common patterns for dashboard sidebars:
    const selectors = [
      'aside nav',
      'aside', 
      '.sidebar',
      '[class*="sidebar"]',
      '[class*="nav"] ul',
      '.navigation ul',
      'nav ul'
    ];

    let navContainer = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        navContainer = el;
        break;
      }
    }

    if (!navContainer) {
      // If not found yet, retry after a delay
      setTimeout(addExecutionRecordsNav, 500);
      return;
    }

    // Check if we already added it
    if (document.getElementById('exec-records-nav-link')) {
      return;
    }

    // Find where to insert (after the last navigation item)
    const navItems = navContainer.querySelectorAll('a, button');
    let insertAfter = navItems[navItems.length - 1];

    // Create the Execution Records link
    const link = document.createElement('a');
    link.id = 'exec-records-nav-link';
    link.href = '/execution-records';
    link.className = insertAfter.className || ''; // Use same styling as existing nav items
    link.innerHTML = '<i class="fas fa-list"></i> Execution Records';
    link.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      margin: 4px 0;
      border-radius: 6px;
      cursor: pointer;
      text-decoration: none;
      color: #c9d1d9;
      transition: background 0.15s;
    `;
    link.onmouseover = () => { link.style.background = '#30363d'; };
    link.onmouseout = () => { link.style.background = ''; };

    // Insert after the last item
    if (insertAfter) {
      insertAfter.parentNode.insertBefore(link, insertAfter.nextSibling);
    } else {
      navContainer.appendChild(link);
    }

    console.log('[Execution Records] Navigation link added');
  }

  // Start trying to add the navigation
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addExecutionRecordsNav);
  } else {
    addExecutionRecordsNav();
  }
})();