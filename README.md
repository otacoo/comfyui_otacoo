# Metadata-Extractor ✨
Extract generation info from images, works for A1111/Forge, NovelAI, InvokeAI, Midjourney and (most) ComfyUI types of metadata.

Can be used as a [standalone](https://github.com/otacoo/comfyui_metadata_extract/releases/latest) web page or installed as ComfyUI custom_node, which will add a button to the menu bar.


### Features:
- Supports PNG, JPEG and WEBP images
- Supports hidden metadata, Alpha, RGB, EXIF UserComment, Make, JSON and JSON-like strings
- Fetch and linkify Civitai models
- Strip metadata
- Light / dark theme

![Screenshot Metadata Extractor](https://github.com/user-attachments/assets/ea50f1d9-48dd-48d1-8be9-32520164b4cf)


### Manual Install

Go into your ComfyUI `custom_nodes` folder, open a terminal and do:
```
git clone https://github.com/otacoo/comfyui_metadata_extract.git
```

![button](https://github.com/user-attachments/assets/77ed794d-cd70-4dd0-8ba3-a43e712ad584)

To disable the widget, go into the ComfyUI menu > Extensions and toggle it off:

![disable_extension](https://github.com/user-attachments/assets/2b7df221-6567-4f1e-ae7e-3b241a7149ef)




