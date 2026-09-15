/* silencio results site - sort a table, filter a table, zoom a figure. */
(function () {
  "use strict";

  function cellValue(row, index) {
    var cell = row.cells[index];
    return cell ? cell.textContent.trim() : "";
  }

  function numeric(text) {
    var match = text.match(/-?\d+(\.\d+)?([eE][-+]?\d+)?/);
    return match ? parseFloat(match[0]) : null;
  }

  function compare(a, b) {
    var na = numeric(a), nb = numeric(b);
    if (na !== null && nb !== null && a.replace(/\s/g, "") !== "" ) {
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    }
    return a.localeCompare(b);
  }

  function makeSortable(table) {
    var headers = table.tHead ? table.tHead.rows[0].cells : [];
    Array.prototype.forEach.call(headers, function (header, index) {
      header.addEventListener("click", function () {
        var ascending = !header.classList.contains("asc");
        Array.prototype.forEach.call(headers, function (other) {
          other.classList.remove("asc", "desc");
        });
        header.classList.add(ascending ? "asc" : "desc");
        var body = table.tBodies[0];
        var rows = Array.prototype.slice.call(body.rows);
        rows.sort(function (x, y) {
          var result = compare(cellValue(x, index), cellValue(y, index));
          return ascending ? result : -result;
        });
        rows.forEach(function (row) { body.appendChild(row); });
      });
    });
  }

  function makeFilter(input) {
    var table = document.getElementById(input.dataset.target);
    if (!table) { return; }
    input.addEventListener("input", function () {
      var needle = input.value.toLowerCase();
      Array.prototype.forEach.call(table.tBodies[0].rows, function (row) {
        row.hidden = needle !== "" && row.textContent.toLowerCase().indexOf(needle) === -1;
      });
    });
  }

  function makeLightbox() {
    var box = document.getElementById("lightbox");
    var image = document.getElementById("lightbox-img");
    var caption = document.getElementById("lightbox-cap");
    if (!box) { return; }
    Array.prototype.forEach.call(document.querySelectorAll("a.zoom"), function (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        image.src = link.getAttribute("href");
        caption.textContent = link.dataset.caption || "";
        box.hidden = false;
      });
    });
    box.addEventListener("click", function () { box.hidden = true; image.src = ""; });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { box.hidden = true; image.src = ""; }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    Array.prototype.forEach.call(document.querySelectorAll("table.sortable"), makeSortable);
    Array.prototype.forEach.call(document.querySelectorAll("input.tablefilter"), makeFilter);
    makeLightbox();
  });
}());
