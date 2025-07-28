//v1.0.3
import { app } from "../../scripts/app.js";

const config = {
    newTab: true,
};

// Store references to created elements for cleanup
let widgetElements = [];
let observers = [];

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
    widgetElements.push(button); // Store reference for cleanup
    return button;
};

const onClick = () => {
    const imgExtractUrl = `${window.location.origin}/imgextract`;
    if (config.newTab) {
        window.open(imgExtractUrl, '_blank');
    } else {
        window.location.href = imgExtractUrl;
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

    observers.push(observer); // Store reference for cleanup
    observer.observe(document.body, { childList: true, subtree: true });
};

const initializeWidget = () => {
    addWidget('.comfyui-menu-right', addWidgetMenuRight);
    addWidget('.comfy-menu', addWidgetMenu);
};

const getExtractorIcon = () => {
    return `✨`;
};

const cleanupWidgets = () => {
    // Remove all created buttons
    widgetElements.forEach(element => {
        if (element && element.parentNode) {
            element.parentNode.removeChild(element);
        }
    });
    widgetElements = [];
    
    // Disconnect all observers
    observers.forEach(observer => observer.disconnect());
    observers = [];
};

app.registerExtension({ 
    name: "otacoo-imgextract.widget",
    
    // Called when the extension is enabled or disabled
    setup(enabled) {
        if (enabled) {
            initializeWidget();
        } else {
            cleanupWidgets();
        }
    },
    
    // This is needed to ensure the extension can be toggled on/off
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        return { nodeType, nodeData };
    }
});
