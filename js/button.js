import { app } from "../../scripts/app.js";

const BUTTON_TOOLTIP = "Launch Metadata Extractor";
const IMGEXTRACT_PATH = "/imgextract";
const NEW_WINDOW_FEATURES = "width=1200,height=800,resizable=yes,scrollbars=yes,status=yes";

const config = {
    newTab: true,
};

const onClick = (event) => {
    const url = `${window.location.origin}${IMGEXTRACT_PATH}`;

    if (event.shiftKey) {
        window.open(url, "_blank", NEW_WINDOW_FEATURES);
        return;
    }

    if (config.newTab) {
        window.open(url, "_blank");
    } else {
        window.location.href = url;
    }
};

const getExtractorIcon = () => {
    return `✨`;
};

const injectStyles = () => {
    const styleId = "otacoo-imgextract-button-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
        button[aria-label="${BUTTON_TOOLTIP}"].otacoo-imgextract-toolbar-btn {
            transition: all 0.2s ease;
            border: 1px solid transparent;
        }
        button[aria-label="${BUTTON_TOOLTIP}"].otacoo-imgextract-toolbar-btn:hover {
            background-color: var(--primary-hover-bg) !important;
        }
    `;
    document.head.appendChild(style);
};

const replaceButtonIcon = () => {
    const buttons = document.querySelectorAll(`button[aria-label="${BUTTON_TOOLTIP}"]`);
    buttons.forEach((button) => {
        button.classList.add("otacoo-imgextract-toolbar-btn");
        button.innerHTML = getExtractorIcon();
        button.style.borderRadius = "4px";
        button.style.padding = "6px";
        button.style.backgroundColor = "var(--primary-bg)";
    });
    if (buttons.length === 0) {
        requestAnimationFrame(replaceButtonIcon);
    }
};

app.registerExtension({
    name: "otacoo-metadata-extract.widget",
    actionBarButtons: [
        {
            icon: "icon-[mdi--image-search] size-4",
            tooltip: BUTTON_TOOLTIP,
            onClick,
        },
    ],
    async setup() {
        injectStyles();
        requestAnimationFrame(replaceButtonIcon);
    },
});
