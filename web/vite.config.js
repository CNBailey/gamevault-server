import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.GV_API || 'http://127.0.0.1:8686';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': target, '/media': target }
  }
});
