import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app/App";

import { IDEContextProvider } from "./context/IDEContextProvider";

import "./styles/globals.css";

ReactDOM.createRoot(

    document.getElementById("root")!,

).render(

    <React.StrictMode>

        <IDEContextProvider>

            <App />

        </IDEContextProvider>

    </React.StrictMode>,

);