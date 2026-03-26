# Beanthentic Coffee

Website at web (Flask) at Android app para sa Beanthentic Coffee.

## Project Structure

```
Beanthentic/
├── index.html              # Homepage (component loading)
├── app.py                  # Flask app – serves index.html at /
├── requirements.txt        # Python: flask
├── css/                    # Styles: base, layout, components, responsive
├── js/                     # Scripts: main, navigation, ui
├── components/             # HTML: header, hero, about, footer
├── android-app/            # Android APK (homepage only)
│   ├── app/src/main/
│   │   ├── assets/         # index.html, css/, js/
│   │   ├── java/           # MainActivity.kt
│   │   └── res/            # Manifest, themes, icons
│   ├── build.gradle.kts
│   └── README.md           # Paano i-build ang APK
└── README.md
```

## Features

- **Modular Architecture**: Separated CSS, JavaScript, and HTML components for better maintainability
- **Responsive Design**: Mobile-first approach with responsive breakpoints
- **Smooth Animations**: CSS animations and JavaScript-powered interactions
- **Component-Based**: Reusable HTML components loaded dynamically
- **Modern JavaScript**: ES6+ features with clean class-based organization

## Getting Started

**Web (Flask)**  
`pip install -r requirements.txt` → `python app.py` → buksan `http://127.0.0.1:5000/`

**Web (static)**  
Buksan lang ang `index.html` sa browser; maglo-load ang components via JavaScript.

**Android APK**  
Tingnan ang `android-app/README.md` para sa build steps.

## File Organization

### CSS Files
- `base.css`: Global styles, resets, typography, and basic button styles
- `layout.css`: Header, navigation, footer, and main layout components
- `components.css`: Specific component styles (hero, about, cards)
- `responsive.css`: Media queries and responsive design rules

### JavaScript Files
- `main.js`: Application initialization and global utilities
- `navigation.js`: Smooth scrolling, active navigation highlighting
- `ui.js`: UI interactions, animations, and user experience enhancements

### HTML Components
- Each component is a separate HTML file for easy maintenance
- Components are loaded dynamically into the main index.html
- This approach allows for better code organization and reusability

## Development

The codebase follows modern web development best practices:
- Semantic HTML5 markup
- CSS with logical organization and clear naming conventions
- Modular JavaScript with class-based architecture
- Responsive design with mobile-first approach
- Accessibility considerations

## Browser Support

Modern browsers that support:
- ES6+ JavaScript features
- CSS Grid and Flexbox
- CSS custom properties (variables)
- Intersection Observer API