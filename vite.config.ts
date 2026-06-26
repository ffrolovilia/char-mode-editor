import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          cytoscape: ["cytoscape"],
          vendor: ["react", "react-dom", "zustand"],
        },
      },
    },
  },
});
