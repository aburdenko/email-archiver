/**
 * Extracts all readable text from a given slide.
 * @param {GoogleAppsScript.Slides.Slide} slide The slide to extract text from.
 * @returns {string} The concatenated text from the slide.
 */
function extractTextFromSlide(slide) {
  // Add a guard clause to ensure the slide object is valid.
  if (!slide || typeof slide.getPageElements !== 'function') {
    Logger.log("Warning: extractTextFromSlide was called with an invalid slide object. Skipping.");
    return "";
  }
  let text = [];
  const pageElements = slide.getPageElements();
  pageElements.forEach(element => {
    if (element.getPageElementType() === SlidesApp.PageElementType.SHAPE) {
      const shape = element.asShape();
      if (shape.getText) {
        const textRange = shape.getText();
        if (textRange && textRange.asString().trim() !== '') {
          text.push(textRange.asString().trim());
        }
      }
    } else if (element.getPageElementType() === SlidesApp.PageElementType.TABLE) {
      const table = element.asTable();
      for (let r = 0; r < table.getNumRows(); r++) {
        for (let c = 0; c < table.getNumColumns(); c++) {
          const cell = table.getCell(r, c);
          const textRange = cell.getText();
          if (textRange && textRange.asString().trim() !== '') {
            text.push(textRange.asString().trim());
          }
        }
      }
    }
  });
  return text.join('\n---\n');
}


/**
 * Calls the Gemini API with a given prompt, using either an API Key or Project-based OAuth.
 * @param {string} prompt The complete prompt to send to the model.
 * @param {Object} authDetails An object containing authentication details.
 * @param {string} [authDetails.geminiApiKey] The API Key from Google AI Studio.
 * @param {string} [authDetails.gcpProjectId] The Google Cloud Project ID for OAuth.
 * @returns {string} The text content from the model's response.
 */
function callGemini(prompt, authDetails, modelId) {
  let model;
  let url;
  let options;
  const payload = {
    "contents": [{
      "role": "user",
      "parts": [{ "text": prompt }]
    }],
    "generationConfig": {
      "temperature": 0.2,
    }
  };

  let modelName;
  // Strictly use the modelId from the form field.
  if (modelId && modelId.trim() !== '') {
    modelName = modelId.trim();
  } else {
    // If the form field is empty, throw an error as per the user's request ("ONLY from the form field").
    throw new Error("Gemini Model ID must be provided in the form field. It cannot be empty.");
  }

  // Prioritize API Key if provided. This is now the default method if a key is present.
  if (authDetails.geminiApiKey) {
    Logger.log(`Using Gemini API Key for authentication with model: ${modelName}`);
    // The Generative Language API (for API keys) uses a different model identifier.
    url = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent`;

    options = {
      'method': 'post',
      'contentType': 'application/json',
      'payload': JSON.stringify(payload),
      'headers': {
        // The generativelanguage API uses an 'x-goog-api-key' header.
        'x-goog-api-key': authDetails.geminiApiKey
      },
      'muteHttpExceptions': true
    };
  } 
  // Fallback to Project-based OAuth if no API key is provided
  else if (authDetails.gcpProjectId && !authDetails.gcpProjectId.includes('__GCP_PROJECT_ID_PLACEHOLDER__')) {
    Logger.log(`Using Project-based OAuth for authentication with model: ${modelName}`);
    
    // The Vertex AI API uses a more specific model identifier.
    const region = "us-central1";
    url = `https://${region}-aiplatform.googleapis.com/v1/projects/${authDetails.gcpProjectId}/locations/${region}/publishers/google/models/${modelName}:generateContent`;

    options = {
      'method': 'post',
      'contentType': 'application/json',
      'payload': JSON.stringify(payload),
      'headers': {
        'Authorization': 'Bearer ' + ScriptApp.getOAuthToken()
      },
      'muteHttpExceptions': true
    };
  } 
  // No valid authentication method found
  else {
    throw new Error("No valid authentication method provided. Please either provide a Gemini API Key in the sidebar or ensure the GCP Project ID is configured correctly.");
  }

  Logger.log("Calling Gemini API...");
  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  // Preprocess responseBody to remove markdown code block fences if present
  // This handles cases where the model wraps JSON in ```json ... ```
  let cleanedResponseBody = responseBody.replace(/```json\s*|\s*```/g, '').trim();

  if (responseCode !== 200) {
    Logger.log(`Gemini API Error: ${responseCode} - ${responseBody}`);
    throw new Error(`Gemini API request failed with status ${responseCode}: ${responseBody}`);
  }

  const result = JSON.parse(cleanedResponseBody);
  // The response structure is consistent enough between the two APIs for this to work.
  if (result.candidates && result.candidates.length > 0 && result.candidates[0].content && result.candidates[0].content.parts && result.candidates[0].content.parts.length > 0) {
    const content = result.candidates[0].content.parts[0].text;
    Logger.log("Received response from Gemini.");
    return content;
  } else {
    Logger.log(`Invalid Gemini Response: ${responseBody}`);
    throw new Error("Received an invalid or empty response from the Gemini API.");
  }
}

/**
 * @OnlyCurrentDoc
 * The onOpen function runs automatically when the presentation is opened.
 * It adds a custom menu to the Slides UI, handling the authorization flow for new users.
 * @param {Object} e The event parameter for a simple trigger.
 */
function onOpen(e) {
  const ui = SlidesApp.getUi();
  const menu = ui.createMenu('Slide Generator');

  // The 'e.authMode' property is available for simple triggers like onOpen.
  // It tells us if the script is authorized. When a user makes a copy of the
  // template, the script is not yet authorized for them.
  if (e && e.authMode == ScriptApp.AuthMode.NONE) {
    // If the script is not authorized, add a menu item to prompt the user.
    // Calling any function that requires authorization will trigger the prompt.
    menu.addItem('Authorize Script', 'showGeneratorSidebar');
  } else {
    // If the script is authorized, show the main functionality.
    menu.addItem('Generate Presentation', 'showGeneratorSidebar');
  }
  menu.addToUi();
}

/**
 * Shows a sidebar in the presentation.
 */
function showGeneratorSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
      .setTitle('Slide Deck Generator')
      .setWidth(350);
  SlidesApp.getUi().showSidebar(html);
}

/**
 * Gets the user's OAuth 2.0 access token for client-side API calls.
 * @returns {string} The user's OAuth 2.0 access token.
 */
function getOAuthToken() {
  return ScriptApp.getOAuthToken();
}

/**
 * A server-side function to get user properties.
 * @returns {Object} The stored user properties.
 */
function getUserProperties() {
  return PropertiesService.getUserProperties().getProperties();
}

/**
 * A server-side function to save user properties.
 * @param {Object} properties The properties to save.
 */
function saveUserProperties(properties) {
  PropertiesService.getUserProperties().setProperties(properties);
}

/**
 * Gets the status of a generation job from the cache.
 * @param {string} jobId The unique ID for the generation job.
 * @returns {string | null} The status message or null if not found.
 */
function getGenerationStatus(jobId) {
  if (!jobId) return null;
  try {
    return CacheService.getScriptCache().get(jobId);
  } catch (e) {
    Logger.log(`Could not read from cache for jobId ${jobId}: ${e.message}`);
    return null; // Return null on cache error
  }
}

/**
 * Helper to update the status of a job in the cache.
 * @param {string} jobId The unique ID for the job.
 * @param {string} message The status message to store.
 */
function updateJobStatus(jobId, message) {
  if (jobId) {
    try {
      // Cache items can be up to 100 KB. Timeout of 1 hour (3600s).
      CacheService.getScriptCache().put(jobId, message, 3600);
      Logger.log(`Status Update (${jobId}): ${message}`);
    } catch (e) {
      Logger.log(`Could not write to cache for jobId ${jobId}: ${e.message}`);
    }
  }
}




/**
 * Helper function to find a Shape by its text content and update it.
 * This is used to target the custom-labeled fields on the title slide.
 * @param {GoogleAppsScript.Slides.Slide} slide The slide to search.
 * @param {string} initialValue The exact text content of the shape to find (e.g., "TITLE").
 * @param {string} newValue The text content to set.
 * @returns {boolean} True if a shape was found and updated, false otherwise.
 */
function updateTextByInitialValue(slide, initialValue, newValue) {
  const pageElements = slide.getPageElements();
  // Loop through all elements, including those on the Master/Layout that are not true placeholders.
  for (const element of pageElements) {
    if (element.getPageElementType() === SlidesApp.PageElementType.SHAPE) {
      const shape = element.asShape();
      const textRange = shape.getText();
      // Check if the shape's current text content exactly matches the initial value (case-sensitive)
      if (textRange && textRange.asString().trim() === initialValue) {
        textRange.setText(newValue);
        return true; // Found and updated one
      }
    }
  }
  return false; // Not found
}

/**
 * Finds the largest text shapes on a slide, assuming they are the title and subtitle.
 * @param {GoogleAppsScript.Slides.Slide} slide The slide to search.
 * @returns {{titleShape: GoogleAppsScript.Slides.Shape | null, subtitleShape: GoogleAppsScript.Slides.Shape | null}}
 */
function findLargestTextShapes(slide) {
  const shapes = slide.getShapes()
    .filter(shape => shape.getText && shape.getText().asString().trim() !== '')
    .sort((a, b) => {
      // Sort by font size primarily, then by shape area as a tie-breaker.
      const fontA = a.getText().getTextStyle().getFontSize() || 0;
      const fontB = b.getText().getTextStyle().getFontSize() || 0;
      if (fontA !== fontB) {
        return fontB - fontA;
      }
      const areaA = a.getWidth() * a.getHeight();
      const areaB = b.getWidth() * b.getHeight();
      return areaB - areaA;
    });

  return {
    titleShape: shapes.length > 0 ? shapes[0] : null,
    subtitleShape: shapes.length > 1 ? shapes[1] : null,
  };
}


/**
 * The main function to process the user's request, call Gemini, and generate the slide deck.
 * This function is called synchronously from the sidebar. It performs all operations
 * and waits for them to complete before returning.
 *
 * @param {Object} formObject The data from the sidebar form.
 * @param {string} jobId A unique identifier for this generation job for status tracking.
 */

function startGeneration(formObject, jobId) {
  // Destructure geminiModelId from formObject
  const activeDeck = SlidesApp.getActivePresentation();
  let originalTitleSlide = null;
  Logger.log(`Synchronous generation started with formObject: ${JSON.stringify(formObject)} and jobId: ${jobId}`);
  updateJobStatus(jobId, 'Starting generation...');

  // --- Step 0: Clean up presentation, keeping only the first slide as a template for the title. ---
  const allSlidesInitial = activeDeck.getSlides();
  if (allSlidesInitial.length > 0) {
    originalTitleSlide = allSlidesInitial[0]; // Capture the original slide for layout/theme later
  }
  if (allSlidesInitial.length > 1) {
    Logger.log(`Presentation has ${allSlidesInitial.length} slides. Removing all but the first.`);
    for (let i = allSlidesInitial.length - 1; i > 0; i--) {
      allSlidesInitial[i].remove();
    }
  }

  try {
    const logOutput = [];
    let { presentationTitle, customerRequest, presentationDuration, sourceFolderId, gcpProjectId, geminiApiKey, geminiModelId, addSpeakerNotes, meetingDate } = formObject;

    if (!sourceFolderId) {
      throw new Error("Source Slides Folder ID is not set. Please paste the folder ID or URL.");
    }
    if (!customerRequest) {
      throw new Error("Customer Request (prompt) cannot be empty.");
    }

    // --- Step 1: Perform immediate updates to the active presentation ---
    activeDeck.setName(presentationTitle || 'Generated Presentation');
    logOutput.push(`Renamed active presentation to: ${activeDeck.getName()}`);

    // --- Create and Update Title Slide ---
    let newTitleSlide = null;
    try {
      // Use the layout from the original first slide, or a default if none exists.
      const titleLayout = originalTitleSlide ? originalTitleSlide.getLayout() : SlidesApp.PredefinedLayout.TITLE_SLIDE;
      
      // If a slide already exists at index 0, we update it instead of inserting a new one.
      if (activeDeck.getSlides().length > 0) {
        newTitleSlide = activeDeck.getSlides()[0];
      } else {
        newTitleSlide = activeDeck.insertSlide(0, titleLayout);
      }
      
      let updatedCount = 0;

      // Try to update standard placeholders first, as they are more reliable.
      const titlePlaceholder = newTitleSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE) || newTitleSlide.getPlaceholder(SlidesApp.PlaceholderType.CENTERED_TITLE);
      if (titlePlaceholder) {
        titlePlaceholder.getText().setText(presentationTitle);
      } else if (!updateTextByInitialValue(newTitleSlide, '{{Title}}', presentationTitle)) {
        // As a final fallback, find the largest text shape and assume it's the title.
        const { titleShape } = findLargestTextShapes(newTitleSlide);
        if (titleShape) {
          titleShape.getText().setText(presentationTitle);
          logOutput.push('Used largest text box as title fallback.');
        }
      }
      // We count an update if the title is no longer the default.
      if (newTitleSlide.getShapes().some(s => s.getText && s.getText().asString().includes(presentationTitle))) {
         updatedCount++;
      }

      const subtitlePlaceholder = newTitleSlide.getPlaceholder(SlidesApp.PlaceholderType.SUBTITLE);
      if (subtitlePlaceholder) {
        // Use subtitle for the customer request if available.
        subtitlePlaceholder.getText().setText(customerRequest);
      } else if (!updateTextByInitialValue(newTitleSlide, '{{Descripition}}', customerRequest) && !updateTextByInitialValue(newTitleSlide, '{{Description}}', customerRequest)) {
        // Final fallback for subtitle.
        const { subtitleShape } = findLargestTextShapes(newTitleSlide);
        if (subtitleShape) {
          subtitleShape.getText().setText(customerRequest);
          logOutput.push('Used second-largest text box as subtitle fallback.');
        }
      }
      // We count an update if the subtitle is no longer the default.
      if (newTitleSlide.getShapes().some(s => s.getText && s.getText().asString().includes(customerRequest))) {
         updatedCount++;
      }
      
      // Format the date for the "Date" field.
      // The `replace` call prevents timezone issues where new Date('YYYY-MM-DD') is parsed as UTC.
      const formattedDate = meetingDate ? new Date(meetingDate.replace(/-/g, '\/')).toLocaleDateString() : new Date().toLocaleDateString();
      if (updateTextByInitialValue(newTitleSlide, '{{Date}}', formattedDate)) {
        updatedCount++;
      }

      logOutput.push(`Updated ${updatedCount} field(s) on the title slide.`);
    } catch (e) {
      logOutput.push(`Warning: An error occurred while trying to update the title slide. Error: ${e.message}`);
    }

    // --- Step 2: Sanitize Input and Get Folder ---
    updateJobStatus(jobId, 'Accessing source folder...');
    const urlRegex = /\/folders\/([a-zA-Z0-9_-]+)/;
    const match = sourceFolderId.match(urlRegex);
    if (match && match[1]) {
      sourceFolderId = match[1];
      Logger.log(`Extracted folder ID from URL: ${sourceFolderId}`);
    }

    let sourceFolder;
    try {
      Logger.log(`Attempting to access folder with ID: ${sourceFolderId}`);
      sourceFolder = DriveApp.getFolderById(sourceFolderId);
    } catch (e) {
      Logger.log(`Failed to get folder by ID. Error: ${e.message}`);
      throw new Error(`Could not access the folder. Please check that the ID "${sourceFolderId}" is correct, that it is a FOLDER (not a file), and that you have at least 'Viewer' permissions.`);
    }

    // --- Step 3: Gather all slide text from the source folder ---
    updateJobStatus(jobId, 'Preparing to scan source presentations...');
    const sourceFiles = sourceFolder.getFiles();
    const allSlidesData = [];
    const processedPresentationIds = new Set();

    while (sourceFiles.hasNext()) {
      const file = sourceFiles.next();
      let presentationId = null;
      const mimeType = file.getMimeType();

      if (mimeType === 'application/vnd.google-apps.shortcut') {
        presentationId = file.getTargetId();
      } else if (mimeType === 'application/vnd.google-apps.presentation') {
        presentationId = file.getId();
      }

      if (presentationId && !processedPresentationIds.has(presentationId)) {
        try {
          const presentation = SlidesApp.openById(presentationId);
          const presentationName = presentation.getName();
          Logger.log(`Processing presentation: ${presentationName}`);
          updateJobStatus(jobId, `Scanning: ${presentationName}`);
          presentation.getSlides().forEach(slide => {
            const slideText = extractTextFromSlide(slide);
            if (slideText) { // Only include slides that have text
              allSlidesData.push({
                presentationId: presentationId,
                slideId: slide.getObjectId(),
                text: slideText
              });
            }
          });
          processedPresentationIds.add(presentationId);
        } catch (e) {
          Logger.log(`Could not access or process presentation with ID ${presentationId}. Skipping. Error: ${e.message}`);
        }
      }
    }

    if (allSlidesData.length === 0) {
      throw new Error("No readable slides with text content were found in the source folder.");
    }
    const statusMsg = `Found ${allSlidesData.length} slides with text. Analyzing with AI...`;
    Logger.log(statusMsg);
    updateJobStatus(jobId, statusMsg);
    
    // --- Step 4: Build the prompt for Gemini ---
    const prompt = `
      You are an expert presentation builder. Your task is to assemble a new slide deck based on a user's request by selecting from a library of existing slides.

      **User Request / Agenda:**
      ${customerRequest}

      **Desired Presentation Duration:**
      ${presentationDuration} minutes.

      **Available Slides Library:**
      Here is a JSON array of available slides. Each object contains the slide's unique IDs and its text content.
      ${JSON.stringify(allSlidesData)}

      **Your Task:**
      1. Analyze the User Request and the text content of each slide in the library.
      2. Select the most relevant slides to build a coherent presentation that addresses the user's request.
      3. The final selection of slides should be appropriate for the desired presentation duration. Assume about 2-3 minutes per slide.
      4. Your response MUST be a valid JSON object containing a single key "slidesToCopy".
      5. The value of "slidesToCopy" must be an array of objects, where each object has a "presentationId" and a "slideId" key corresponding to your selected slides.
      6. Do NOT include any other text, explanations, or markdown formatting in your response. Only the JSON object is allowed.

      Example of a valid response:
      {
        "slidesToCopy": [
          { "presentationId": "abc...", "slideId": "g123..." },
          { "presentationId": "xyz...", "slideId": "g456..." }
        ]
      }
    `;

    // --- Step 5: Call Gemini and process the response ---
    const geminiResponse = callGemini(prompt, { gcpProjectId: gcpProjectId, geminiApiKey: geminiApiKey }, geminiModelId);
    const result = JSON.parse(geminiResponse);
    let { slidesToCopy } = result;
    updateJobStatus(jobId, 'AI analysis complete. Filtering known incompatible slides...');

    if (!slidesToCopy || slidesToCopy.length === 0) {
      throw new Error("Gemini did not return any slides to copy. The prompt might not have matched any content, or the model's response was invalid.");
    }

    // --- Generate and Insert Agenda Slide ---
    updateJobStatus(jobId, 'Generating agenda slide...');
    let agendaSlideInsertionIndex = 1; // Start inserting after the title slide (index 0)
    try {
      const agendaPrompt = `Based on the following user request, generate a concise agenda for a presentation.
User Request: "${customerRequest}"
Your response MUST be a valid JSON object with a "title" (e.g., "Agenda") and a "points" (an array of strings for the bullet points).
Example: {"title": "Agenda", "points": ["Introduction", "Problem Statement", "Proposed Solution", "Next Steps"]}`;

      const agendaResponse = callGemini(agendaPrompt, { gcpProjectId: gcpProjectId, geminiApiKey: geminiApiKey }, geminiModelId);
      const agendaData = JSON.parse(agendaResponse);

      if (agendaData && agendaData.title && agendaData.points) {
        let agendaSlide;
        try {
          // Try to use the standard Title and Body layout first.
          agendaSlide = activeDeck.insertSlide(agendaSlideInsertionIndex, SlidesApp.PredefinedLayout.TITLE_AND_BODY);
        } catch (e) {
          // If it fails, the master is likely custom. Fall back to the layout of the title slide.
          logOutput.push('Warning: Predefined layout "TITLE_AND_BODY" not found. Attempting fallback for agenda.');
          let fallbackLayout = SlidesApp.PredefinedLayout.BLANK;
          if (newTitleSlide) {
            fallbackLayout = newTitleSlide.getLayout();
          }
          agendaSlide = activeDeck.insertSlide(agendaSlideInsertionIndex, fallbackLayout);
        }

        // Now, try to populate the slide, checking for placeholders.
        const titlePlaceholder = agendaSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE);
        if (titlePlaceholder) titlePlaceholder.getText().setText(agendaData.title);
        
        const bodyPlaceholder = agendaSlide.getPlaceholder(SlidesApp.PlaceholderType.BODY);
        if (bodyPlaceholder) {
          agendaData.points.forEach(point => bodyPlaceholder.getText().appendListItem(point));
        }
        agendaSlideInsertionIndex++; // Increment index for content slides
        logOutput.push('Generated and inserted agenda slide.');
      } else {
        logOutput.push('Warning: Could not generate a valid agenda from the model\'s response.');
      }
    } catch (e) {
      logOutput.push(`Warning: Failed to generate agenda slide. Error: ${e.message}`);
    }
    
    // --- Add Content Slides ---
    updateJobStatus(jobId, 'Copying content elements to new slides...');
    logOutput.push('Copying selected slide elements...');
    for (const slideInfo of slidesToCopy) {
      let logMsg = '';
      let newSlide = null; // This will hold the newly created slide

      try {
        const sourceDeck = SlidesApp.openById(slideInfo.presentationId);
        const slideToCopy = sourceDeck.getSlideById(slideInfo.slideId);

        if (slideToCopy) {
          // API QUIRK WORKAROUND: The object returned by appendSlide() is incomplete.
          // To get a fully functional Slide object, we must get its ID from the
          // incomplete object and then fetch it again from the presentation.

          try {
            // Attempt to copy the slide using NOT_LINKED mode, which is more robust against theme/layout mismatches.
            const sourceSlideNumber = slideToCopy.getSlideIndex() + 1; // Get the 1-based index
            const appendedSlide = activeDeck.appendSlide(slideToCopy, SlidesApp.SlideLinkingMode.NOT_LINKED);
            // Now, get the fully-hydrated slide object using its ID. This is the most reliable method.
            newSlide = activeDeck.getSlideById(appendedSlide.getObjectId());

            logMsg = `  - Copied slide #${sourceSlideNumber} from '${sourceDeck.getName()}' (NOT_LINKED)`;
          } catch (copyError) {
            const sourceSlideNumber = slideToCopy.getSlideIndex() + 1;
            logMsg = `  - SKIPPED SLIDE #${sourceSlideNumber}: Copy failed due to layout incompatibility. Error: ${copyError.message}`;
            logOutput.push(logMsg);
            Logger.log(`CRITICAL: Failed to copy slide ${slideInfo.slideId} from ${sourceDeck.getName()}. Error: ${copyError.message}`);
            continue; // Skip to the next slide in the loop
          }
        } else {
          logMsg = `  - WARNING: Slide ${slideInfo.slideId} not found in presentation ${slideInfo.presentationId}. Skipping.`;
          logOutput.push(logMsg);
          Logger.log(logMsg);
          continue;
        }
      } catch (e) {
        // This catches errors from openById, getSlideById, etc.
        logMsg = `  - CRITICAL ERROR: Could not access file/slide for ID '${slideInfo.slideId}'. Skipping. Final Error: ${e.message}`;
        logOutput.push(logMsg);
        Logger.log(logMsg);
        continue; // Skip to next slide on critical error
      }

      // --- Add Speaker Notes (if requested) ---
      if (newSlide && addSpeakerNotes) {
        // API QUIRK: The slide object returned by appendSlide() doesn't have all methods.
        // To work around this and the `getSpeakerNotesShape is not a function` error, we will
        // access the speaker notes via the slide's master, which is a more reliable method.
        const speakerNotesMaster = newSlide.getSpeakerNotesMaster();
        const speakerNotesShape = speakerNotesMaster ? speakerNotesMaster.getPlaceholder(SlidesApp.PlaceholderType.BODY) : null;
        
        if (speakerNotesShape) {
          const speakerNotesText = speakerNotesShape.getText();
          // Re-open source deck for metadata in speaker notes
          const sourceDeck = SlidesApp.openById(slideInfo.presentationId); 
          const sourceDeckName = sourceDeck.getName();
          const sourceUrl = sourceDeck.getUrl();
          const slideIndex = newSlide.getSlideIndex();
          const sourceSlideNumber = sourceDeck.getSlides().findIndex(s => s.getObjectId() === slideInfo.slideId) + 1;
          const sourceReference = `\n\n---\nSource: '${sourceDeckName}' (Original slide ${sourceSlideNumber})\n${sourceUrl}`;

          // Start with the notes from the original source slide.
          const sourceSlide = SlidesApp.openById(slideInfo.presentationId).getSlideById(slideInfo.slideId);
          let notesContent = sourceSlide.getSpeakerNotesShape()?.getText()?.asString()?.trim() || '';

          // If the slide has no notes, try to generate them.
          if (!notesContent) {
            try {
              const slideText = extractTextFromSlide(newSlide); // Use the original newSlide object here
              if (slideText && slideText.trim() !== '') {
                const speakerNotesPrompt = `You are a presentation coach. Based on the following slide content, generate concise and helpful speaker notes. Your response MUST be a valid JSON object with a single key "notes" containing the speaker notes as a string. Do not include the slide content itself in your response. Slide Content:\n\n${slideText}`;
                const speakerNotesResponse = callGemini(speakerNotesPrompt, { gcpProjectId: formObject.gcpProjectId, geminiApiKey: formObject.geminiApiKey }, formObject.geminiModelId);
                const speakerNotesData = JSON.parse(speakerNotesResponse);
                
                if (speakerNotesData && speakerNotesData.notes) {
                  notesContent = speakerNotesData.notes;
                  logMsg += '\n    - Added AI-generated speaker notes.';
                } else {
                  logMsg += '\n    - WARNING: Received empty speaker notes from model.';
                }
              } else {
                logMsg += '\n    - Skipped AI speaker notes generation (no text on slide).';
              }
            } catch (e) {
              logMsg += `\n    - WARNING: Failed to generate speaker notes. Error: ${e.message}`;
            }
          } else {
            logMsg += '\n    - Kept existing speaker notes.';
          }

          // Combine the notes (either existing or generated) with the source reference.
          const finalNotes = notesContent ? notesContent + sourceReference : sourceReference.trim();
          speakerNotesText.setText(finalNotes);
          logMsg += '\n    - Appended source link to speaker notes.';
        } else {
           // Case where getSpeakerNotesShape() returns null (the corrected flow)
           logMsg += '\n    - WARNING: Cannot add speaker notes; copied slide layout has no speaker notes placeholder.';
        }
      }
      Logger.log(logMsg);
      logOutput.push(logMsg);
    }

    // --- Generate and Insert "Next Steps" Slide ---
    updateJobStatus(jobId, 'Generating "Next Steps" slide...');
    try {
      // Get the titles of the slides that were actually copied to give context to the model.
      const copiedSlideTitles = activeDeck.getSlides()
        .map(slide => {
          const titlePlaceholder = slide.getPlaceholder(SlidesApp.PlaceholderType.TITLE) || slide.getPlaceholder(SlidesApp.PlaceholderType.CENTERED_TITLE);
          return titlePlaceholder ? titlePlaceholder.getText().asString().trim() : null;
        })
        .filter(title => title); // Filter out nulls and empty strings

      const nextStepsPrompt = `Based on the following user request and the titles of the slides presented, generate a concise "Next Steps" or "Call to Action" slide.
User Request: "${customerRequest}"
Presented Slide Titles: ${JSON.stringify(copiedSlideTitles)}
Your response MUST be a valid JSON object with a "title" (e.g., "Next Steps") and a "points" (an array of strings for the bullet points).
Example: {"title": "Next Steps", "points": ["Schedule follow-up meeting", "Provide detailed quote", "Begin pilot program"]}`;

      const nextStepsResponse = callGemini(nextStepsPrompt, { gcpProjectId: gcpProjectId, geminiApiKey: geminiApiKey }, geminiModelId);
      const nextStepsData = JSON.parse(nextStepsResponse);

      if (nextStepsData && nextStepsData.title && nextStepsData.points) {
        let nextStepsSlide;
        try {
          // Use the same robust layout-finding logic as the agenda slide.
          nextStepsSlide = activeDeck.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
        } catch (e) {
          logOutput.push('Warning: Predefined layout "TITLE_AND_BODY" not found. Attempting fallback for Next Steps slide.');
          const fallbackLayout = activeDeck.getMasters()[0]?.getLayouts()[0] || SlidesApp.PredefinedLayout.BLANK;
          nextStepsSlide = activeDeck.appendSlide(fallbackLayout);
        }

        const titlePlaceholder = nextStepsSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE)?.asShape();
        if (titlePlaceholder) titlePlaceholder.getText().setText(nextStepsData.title);

        const bodyPlaceholder = nextStepsSlide.getPlaceholder(SlidesApp.PlaceholderType.BODY)?.asShape();
        if (bodyPlaceholder) nextStepsData.points.forEach(point => bodyPlaceholder.getText().appendListItem(point));
        logOutput.push('Generated and inserted Next Steps slide.');
      }
    } catch (e) {
      logOutput.push(`Warning: Failed to generate Next Steps slide. Error: ${e.message}`);
    }
    logOutput.push("✅ Generation complete.");
    updateJobStatus(jobId, 'Finalizing presentation...');

    
    // --- Clean up initial slides as requested ---
    try {
      const slides = activeDeck.getSlides();
      if (slides.length >= 2) {
        logOutput.push("Removing initial title and blank slides...");
        slides[0].remove(); // Remove original title slide
        slides[1].remove(); // Remove what was the second slide (e.g., blank or agenda)
      }
    } catch(e) {
      logOutput.push(`Warning: Could not remove initial slides. Error: ${e.message}`);
    }
    // --- Final Step: Create a status slide with the log output ---
    let statusSlide;
    let finalStatusLog = "✅ Generation Status: SUCCESS";
    
    // --- Create Status Slide (with robust fallbacks) ---
    try {
      // Attempt 1: Try to use the standard TITLE_AND_BODY layout.
      statusSlide = activeDeck.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
    } catch (e) {
      Logger.log(`LAYOUT FALLBACK 1: Standard 'TITLE_AND_BODY' layout not found. Error: ${e.message}.`);
      finalStatusLog = `⚠️ Generation SUCCESS (Layout Errors Encountered)`;
      
      try {
        // Attempt 2: Find the first available layout in the presentation's master.
        const layouts = activeDeck.getMasters()[0].getLayouts();
        if (layouts.length > 0) {
          statusSlide = activeDeck.appendSlide(layouts[0]);
          Logger.log(`LAYOUT FALLBACK 2: Using the first available layout: '${layouts[0].getDisplayName() || 'Untitled Layout'}'`);
        } else {
          // If there are no layouts, this will throw, and we'll go to the final catch block.
          throw new Error("No layouts found in the presentation master.");
        }
      } catch (e2) {
        // Attempt 3 (Final Fallback): Insert a completely blank slide without a predefined layout.
        // This is the most robust method but requires manually creating text boxes.
        Logger.log(`LAYOUT FALLBACK 3: Could not use any existing layout. Error: ${e2.message}. Inserting a blank slide.`);
        try {
          statusSlide = activeDeck.insertSlide(activeDeck.getSlides().length);
          const titleShape = statusSlide.insertShape(SlidesApp.ShapeType.TEXT_BOX, 50, 50, 622, 50);
          titleShape.getText().setText(finalStatusLog);
          titleShape.getText().getTextStyle().setBold(true).setFontSize(24);
          const bodyShape = statusSlide.insertShape(SlidesApp.ShapeType.TEXT_BOX, 50, 110, 622, 400);
          bodyShape.getText().setText(logOutput.join('\n'));
        } catch (e3) {
          Logger.log(`CRITICAL FINALIZATION ERROR: Failed to create status slide entirely. Error: ${e3.message}`);
          updateJobStatus(jobId, `COMPLETED (Critical Error during final slide creation): ${e3.message}`);
          return; // Return early, the script cannot complete the final action.
        }
      }
    }

    // --- Populate Status Slide (Only if a slide object was successfully created) ---
    if (statusSlide && statusSlide.getPlaceholder) {
      const statusTitle = statusSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE)?.asShape();
      if (statusTitle) {
        statusTitle.getText().setText(finalStatusLog);
      }

      const statusBody = statusSlide.getPlaceholder(SlidesApp.PlaceholderType.BODY)?.asShape();
      if (statusBody) {
        statusBody.getText().setText(logOutput.join('\n'));
      } else {
        // If the slide was created but has no placeholders (e.g., from a custom layout),
        // we don't want to error out. The manually created text boxes will suffice.
        Logger.log("Status slide was created, but it has no standard 'TITLE' or 'BODY' placeholders to populate.");
      }
    }
    
    // Send the final status update before the function returns successfully.
    updateJobStatus(jobId, 'Generation Completed');

  } catch (e) {
    Logger.log(`Error in generateSlides: ${e.toString()}\n${e.stack}`);
    
    // If it's a permission error, create a more descriptive error to throw to the client.
    if (e.message.includes("Action not allowed")) {
       const userEmail = Session.getActiveUser().getEmail() || "your account";
       const friendlyError = new Error(`Permission Denied. Please ensure the account '${userEmail}' has EDIT access to this presentation and at least VIEWER access to the source folder and its files.`);
       updateJobStatus(jobId, `ERROR: ${friendlyError.message}`);
       throw friendlyError; // Throw the new, more descriptive error.
    } else {
       // For all other errors, update status with the original message.
       updateJobStatus(jobId, `ERROR: ${e.message}`);
    }
    
    let errorSlide;
    try {
        // Try to create an error slide using the most robust method (TITLE_AND_BODY fallback)
        errorSlide = activeDeck.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
        errorSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE).getText().setText(`❌ Generation Failed`);
        errorSlide.getPlaceholder(SlidesApp.PlaceholderType.BODY).getText().setText(`Error Message: ${e.message}\n\nCheck the Apps Script Logs for full details.`);
    } catch (layoutError) {
        // If even the error slide fails, log it and move on.
        Logger.log(`Could not create error slide. Error: ${layoutError.message}`);
    }

    // IMPORTANT: Re-throw the error so that the client-side .withFailureHandler()
    // in the sidebar is triggered, showing the error message to the user.
    throw e;
  }
}