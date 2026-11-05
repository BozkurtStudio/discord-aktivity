import { defineConfig } from 'vite';

// Geliştirme sırasında backend farklı bir portta çalışıyorsa:
//   API_PORT=3100 npm run dev
const apiTarget = `http://localhost:${process.env.API_PORT || 3000}`;

export default defineConfig({
    server: {
        allowedHosts: true,
        proxy: {
            '/api': {
                target: apiTarget,
                changeOrigin: true
            },
            '/proxy': {
                target: apiTarget,
                changeOrigin: true
            },
            '/socket.io': {
                target: apiTarget,
                ws: true
            }
        }
    }
});