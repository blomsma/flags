import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const serverTarget = `http://127.0.0.1:${process.env.PORT ?? '4174'}`;

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        ceremony: resolve(process.cwd(), 'index.html'),
        control: resolve(process.cwd(), 'control.html')
      }
    }
  },
  server: {
    host: true,
    proxy: {
      '/ws': {
        target: serverTarget,
        ws: true
      },
      '/flags': {
        target: serverTarget,
        changeOrigin: true
      },
      '/api': {
        target: serverTarget,
        changeOrigin: true
      },
      '/media': {
        target: serverTarget,
        changeOrigin: true
      }
    }
  },
  preview: {
    host: true
  }
});
