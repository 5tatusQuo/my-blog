(function () {
  const stage = document.querySelector("#navigation-stage");
  const items = Array.from(document.querySelectorAll(".menu-item"));

  if (!stage || !items.length) return;

  let activeIndex = 0;

  function select(index, focusItem) {
    activeIndex = (index + items.length) % items.length;
    stage.style.setProperty("--active-index", activeIndex);

    items.forEach((item, itemIndex) => {
      const isActive = itemIndex === activeIndex;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-current", isActive ? "true" : "false");
    });

    if (focusItem) items[activeIndex].focus();
  }

  items.forEach((item, index) => {
    item.addEventListener("pointerenter", () => select(index, false));
    item.addEventListener("focus", () => select(index, false));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      select(activeIndex + 1, true);
    }

    if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      select(activeIndex - 1, true);
    }

    if (event.key === "Enter" && document.activeElement === document.body) {
      items[activeIndex].click();
    }
  });

  select(0, false);
})();
