export const renderUnknownChainView = (
    storeId: string,
    chainName: string
  ) => {
    return `
      <div style="display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f0f0;">
        <div style="width: 90%; max-width: 500px; border: 1px solid #ddd; border-radius: 10px; padding: 20px; background-color: #ffffff; box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1);">
          <div style="text-align: center;">
            <h2 style="margin: 0; font-size: 1.5em; color: #333;">Unknown Chain</h2>
            <p style="margin: 10px 0; color: #777;">The chain <strong style="color: #333;">${chainName}</strong> is not recognized.</p>
            <p style="margin: 0; font-size: 0.9em; color: #555;">Store ID: <a href="/${storeId}" style="color: #007BFF; text-decoration: none;">${storeId}</a></p>
          </div>
          <div style="margin-top: 20px; display: flex; align-items: center; justify-content: center; color: #555;">
            <img src="data:image/svg+xml;base64,${btoa(chainSvg())}" alt="Chain Graphic" style="width: 50px; height: 50px;" />
            <span style="margin-left: 10px;">This chain name is either unknown or unsupported on this node.</span>
          </div>
        </div>
      </div>
    `;
  };
  
  // Function to return a simple SVG chain graphic
  const chainSvg = () => `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-link">
      <path d="M10 13a5 5 0 0 1 0-7L13 3a5 5 0 0 1 7 7l-3 3a5 5 0 0 1-7 0" />
      <path d="M14 11a5 5 0 0 1 0 7l-3 3a5 5 0 0 1-7-7l3-3a5 5 0 0 1 7 0" />
    </svg>
  `;
  