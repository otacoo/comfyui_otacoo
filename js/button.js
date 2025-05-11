//v1.0.0
import { app } from "../../scripts/app.js";

const extension = {
    name: "otacoo-imgextract.widget",
};

app.registerExtension(extension);
const config = {
    newTab: true,
};

const createWidget = ({ className, text, tooltip, includeIcon, labelIcon }) => {
    const button = document.createElement('button');
    button.className = className;
    button.setAttribute('aria-label', tooltip);
    button.title = tooltip;

    if (includeIcon && labelIcon) {
        const iconContainer = document.createElement('span');
        iconContainer.innerHTML = labelIcon;
        iconContainer.style.display = 'flex';
        iconContainer.style.alignItems = 'center';
        iconContainer.style.justifyContent = 'center';
        iconContainer.style.width = '20px';
        iconContainer.style.height = '16px';
        button.appendChild(iconContainer);
    }

    const textNode = document.createTextNode(text);
    button.appendChild(textNode);

    button.addEventListener('click', onClick);
    return button;
};

const onClick = () => {
    const imgInfoUrl = `${window.location.origin}/imgextract`;
    if (config.newTab) {
        window.open(imgInfoUrl, '_blank');
    } else {
        window.location.href = imgInfoUrl;
    }
};

const addWidgetMenuRight = (menuRight) => {
    let buttonGroup = menuRight.querySelector('.comfyui-button-group');

    if (!buttonGroup) {
        buttonGroup = document.createElement('div');
        buttonGroup.className = 'comfyui-button-group';
        menuRight.appendChild(buttonGroup);
    }

    const imageinfoButton = createWidget({
        className: 'comfyui-button comfyui-menu-mobile-collapse primary',
        text: '',
        tooltip: 'Launch Metadata Extractor',
        includeIcon: true,
        labelIcon: getExtractorIcon(),
    });

    buttonGroup.appendChild(imageinfoButton);
};

const addWidgetMenu = (menu) => {
    const resetViewButton = menu.querySelector('#comfy-reset-view-button');
    if (!resetViewButton) {
        return;
    }

    const imageinfoButton = createWidget({
        className: 'comfy-imginfo-button',
        text: 'Image Info',
        tooltip: 'Launch Metadata Extractor',
        includeIcon: false,
    });

    resetViewButton.insertAdjacentElement('afterend', imageinfoButton);
};

const addWidget = (selector, callback) => {
    const observer = new MutationObserver((mutations, obs) => {
        const element = document.querySelector(selector);
        if (element) {
            callback(element);
            obs.disconnect();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
};

const initializeWidgets = () => {
    addWidget('.comfyui-menu-right', addWidgetMenuRight);
    addWidget('.comfy-menu', addWidgetMenu);
};

const getExtractorIcon = () => {
    return `✨`;
};

initializeWidgets();
