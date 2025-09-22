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
function callGemini(prompt, authDetails) {
  let model;
  let url;
  let options;
  const payload = {
    "contents": [{
      "role": "user",
      "parts": [{ "text": prompt }]
    }],
    "generationConfig": {
      "response_mime_type": "application/json",
      "temperature": 0.2,
    }
  };

  // Prioritize API Key if provided. This is now the default method if a key is present.
  if (authDetails.geminiApiKey) {
    Logger.log("Using Gemini API Key for authentication.");
    // The Generative Language API (for API keys) uses a different model identifier.
    model = "gemini-1.5-flash-latest";
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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
    Logger.log("Using Project-based OAuth for authentication.");
    // The Vertex AI API uses a more specific model identifier.
    model = "gemini-1.5-pro-preview-0409";
    const region = "us-central1";
    url = `https://${region}-aiplatform.googleapis.com/v1/projects/${authDetails.gcpProjectId}/locations/${region}/publishers/google/models/${model}:generateContent`;

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

  if (responseCode !== 200) {
    Logger.log(`Gemini API Error: ${responseCode} - ${responseBody}`);
    throw new Error(`Gemini API request failed with status ${responseCode}. Check Logs for details.`);
  }

  const result = JSON.parse(responseBody);
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
 * The main function to process the user's request, call Gemini, and generate the slide deck.
 * This function is called synchronously from the sidebar. It performs all operations
 * and waits for them to complete before returning.
 *
 * @param {Object} formObject The data from the sidebar form.
 * @param {string} jobId A unique identifier for this generation job for status tracking.
 */
function startGeneration(formObject, jobId) {
  const activeDeck = SlidesApp.getActivePresentation();
  Logger.log(`Synchronous generation started with formObject: ${JSON.stringify(formObject)} and jobId: ${jobId}`);
  updateJobStatus(jobId, 'Starting generation...');

  // --- Step 0: Clean up presentation, keeping only the first slide as a template for the title. ---
  const allSlidesInitial = activeDeck.getSlides();
  if (allSlidesInitial.length > 1) {
    Logger.log(`Presentation has ${allSlidesInitial.length} slides. Removing all but the first.`);
    for (let i = allSlidesInitial.length - 1; i > 0; i--) {
      allSlidesInitial[i].remove();
    }
  }

  try {
    const logOutput = [];
    let { presentationTitle, customerRequest, presentationDuration, sourceFolderId, gcpProjectId, geminiApiKey, addSpeakerNotes, meetingDate } = formObject;

    if (!sourceFolderId) {
      throw new Error("Source Slides Folder ID is not set. Please paste the folder ID or URL.");
    }
    if (!customerRequest) {
      throw new Error("Customer Request (prompt) cannot be empty.");
    }

    // --- Step 1: Perform immediate updates to the active presentation ---
    activeDeck.setName(presentationTitle || 'Generated Presentation');
    logOutput.push(`Renamed active presentation to: ${activeDeck.getName()}`);

    // --- Update Title Slide (if it exists) ---
    const slides = activeDeck.getSlides();
    if (slides.length > 0) {
      try {
        const titleSlide = slides[0];
        let updatedCount = 0;

        // Try to update standard placeholders first, as they are more reliable.
        const titlePlaceholder = titleSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE) || titleSlide.getPlaceholder(SlidesApp.PlaceholderType.CENTERED_TITLE);
        if (titlePlaceholder) {
          titlePlaceholder.getText().setText(presentationTitle);
          updatedCount++;
        } else {
          // Fallback to custom-labeled field if no standard title placeholder is found.
          if (updateTextByInitialValue(titleSlide, 'TITLE', presentationTitle)) {
            updatedCount++;
          }
        }

        const subtitlePlaceholder = titleSlide.getPlaceholder(SlidesApp.PlaceholderType.SUBTITLE);
        if (subtitlePlaceholder) {
          // Use subtitle for the customer request if available.
          subtitlePlaceholder.getText().setText(customerRequest);
          updatedCount++;
        } else {
          // Fallback to custom-labeled field.
          if (updateTextByInitialValue(titleSlide, 'Description', customerRequest)) {
            updatedCount++;
          }
        }
        
        // Format the date for the "Date" field. This is likely a custom field.
        // The `replace` call prevents timezone issues where new Date('YYYY-MM-DD') is parsed as UTC.
        const formattedDate = meetingDate ? new Date(meetingDate.replace(/-/g, '\/')).toLocaleDateString() : new Date().toLocaleDateString();
        if (updateTextByInitialValue(titleSlide, 'Date', formattedDate)) {
          updatedCount++;
        }

        logOutput.push(`Updated ${updatedCount} field(s) on the title slide.`);
      } catch (e) {
        logOutput.push(`Warning: An error occurred while trying to update the title slide. Error: ${e.message}`);
      }
    } else {
      logOutput.push('Warning: Presentation has no slides. Skipping title slide update.');
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

    // --- Step 5: Call Gemini and parse the response ---
    const geminiResponse = callGemini(prompt, { gcpProjectId: gcpProjectId, geminiApiKey: geminiApiKey });
    const result = JSON.parse(geminiResponse);
    const { slidesToCopy } = result;
    updateJobStatus(jobId, 'AI analysis complete. Generating agenda...');

    if (!slidesToCopy || slidesToCopy.length === 0) {
      throw new Error("Gemini did not return any slides to copy. The prompt might not have matched any content, or the model's response was invalid.");
    }

    // --- Generate and Insert Agenda Slide ---
    updateJobStatus(jobId, 'Generating agenda slide...');
    try {
      const agendaPrompt = `Based on the following user request, generate a concise agenda for a presentation.
User Request: "${customerRequest}"
Your response MUST be a valid JSON object with a "title" (e.g., "Agenda") and a "points" (an array of strings for the bullet points).
Example: {"title": "Agenda", "points": ["Introduction", "Problem Statement", "Proposed Solution", "Next Steps"]}`;

      const agendaResponse = callGemini(agendaPrompt, { gcpProjectId: gcpProjectId, geminiApiKey: geminiApiKey });
      const agendaData = JSON.parse(agendaResponse);

      if (agendaData && agendaData.title && agendaData.points) {
        let agendaSlide;
        try {
          // Try to use the standard Title and Body layout first.
          agendaSlide = activeDeck.insertSlide(1, SlidesApp.PredefinedLayout.TITLE_AND_BODY);
        } catch (e) {
          // If it fails, the master is likely custom. Fall back to the layout of the first slide.
          logOutput.push('Warning: Predefined layout "TITLE_AND_BODY" not found. Attempting fallback for agenda.');
          let fallbackLayout;
          if (activeDeck.getSlides().length > 0) {
            fallbackLayout = activeDeck.getSlides()[0].getLayout();
          } else {
            fallbackLayout = SlidesApp.PredefinedLayout.BLANK;
          }
          agendaSlide = activeDeck.insertSlide(1, fallbackLayout);
        }

        // Now, try to populate the slide, checking for placeholders.
        const titlePlaceholder = agendaSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE);
        if (titlePlaceholder) titlePlaceholder.getText().setText(agendaData.title);
        
        const bodyPlaceholder = agendaSlide.getPlaceholder(SlidesApp.PlaceholderType.BODY);
        if (bodyPlaceholder) {
          agendaData.points.forEach(point => bodyPlaceholder.getText().appendListItem(point));
        }
        logOutput.push('Generated and inserted agenda slide.');
      } else {
        logOutput.push('Warning: Could not generate a valid agenda from the model\'s response.');
      }
    } catch (e) {
      logOutput.push(`Warning: Failed to generate agenda slide. Error: ${e.message}`);
    }

    
    // --- Add Content Slides ---
    updateJobStatus(jobId, 'Copying content slides...');
    logOutput.push('Copying selected slides...');
    slidesToCopy.forEach(slideInfo => {
      let logMsg = '';
      let newSlide;
      try {
        const sourceDeck = SlidesApp.openById(slideInfo.presentationId);
        const slideToCopy = sourceDeck.getSlideById(slideInfo.slideId);
        
        if (slideToCopy) {
          
          try {
            // Attempt 1: Try to copy the slide with its linked master/theme first.
            newSlide = activeDeck.appendSlide(slideToCopy, SlidesApp.SlideLinkingMode.LINKED);
            logMsg = `  - Copied slide from '${sourceDeck.getName()}' (LINKED)`;
          } catch (copyErrorLinked) {
            // Attempt 2: Fallback to NOT_LINKED if the LINKED attempt fails.
            Logger.log(`Linked copy failed: ${copyErrorLinked.message}. Trying NOT_LINKED.`);
            try {
              newSlide = activeDeck.appendSlide(slideToCopy, SlidesApp.SlideLinkingMode.NOT_LINKED);
              logMsg = `  - Copied slide from '${sourceDeck.getName()}' (NOT_LINKED fallback)`;
            } catch (copyErrorUnlinked) {
              // FINAL FALLBACK: If NOT_LINKED also fails, insert a placeholder error slide.
              logMsg = `  - ERROR: Slide copy failed due to layout/theme mismatch. Inserting a placeholder. Error: ${copyErrorUnlinked.message}`;
              try {
                const errorPlaceholderSlide = activeDeck.appendSlide(SlidesApp.PredefinedLayout.BLANK);
                const titleShape = errorPlaceholderSlide.insertShape(SlidesApp.ShapeType.TEXT_BOX, 50, 50, 622, 50); // Dimensions for a standard slide
                titleShape.getText().setText('Slide Failed to Copy');
                const bodyShape = errorPlaceholderSlide.insertShape(SlidesApp.ShapeType.TEXT_BOX, 50, 110, 622, 200);
                bodyShape.getText().setText(`A slide could not be copied from the source presentation due to an incompatible layout.\n\nSource: '${sourceDeck.getName()}'\nSlide URL (approximate): ${sourceDeck.getUrl()}`);
                titleShape.getText().getTextStyle().setBold(true).setFontSize(24);
              } catch (placeholderError) {
                logMsg += `\n    - CRITICAL: Failed to even insert a blank placeholder slide. Error: ${placeholderError.message}`;
              }
              Logger.log(logMsg);
              logOutput.push(logMsg);
              return; // Continue to the next slide in the list
            }
          }
          
          // --- Add Speaker Notes (if requested) ---
          if (addSpeakerNotes) {
            const speakerNotesShape = newSlide.getSpeakerNotesShape();
            if (!speakerNotesShape) {
              logMsg += '\n    - WARNING: Cannot add speaker notes; slide layout has no speaker notes placeholder.';
            } else {
              // First, get the source reference information.
              const sourceDeckName = sourceDeck.getName();
              const sourceUrl = sourceDeck.getUrl();
              const slideIndex = sourceDeck.getSlides().findIndex(s => s.getObjectId() === slideInfo.slideId);
              const slideNumber = slideIndex !== -1 ? slideIndex + 1 : 'N/A';
              const sourceReference = `\n\n---\nSource: '${sourceDeckName}' (Slide ${slideNumber})\n${sourceUrl}`;

              // Start with the notes from the copied slide.
              let notesContent = speakerNotesShape.getText().asString().trim();

              // If the slide has no notes, try to generate them.
              if (!notesContent) {
                try {
                  const slideText = extractTextFromSlide(newSlide);
                  if (slideText) {
                    const speakerNotesPrompt = `You are a presentation coach. Based on the following slide content, generate concise and helpful speaker notes. Your response MUST be a valid JSON object with a single key "notes" containing the speaker notes as a string. Do not include the slide content itself in your response. Slide Content:\n\n${slideText}`;
                    const speakerNotesResponse = callGemini(speakerNotesPrompt, { gcpProjectId: gcpProjectId, geminiApiKey: geminiApiKey });
                    const speakerNotesData = JSON.parse(speakerNotesResponse);
                    
                    if (speakerNotesData && speakerNotesData.notes) {
                      notesContent = speakerNotesData.notes; // Use the generated notes.
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
              speakerNotesShape.getText().setText(finalNotes);              
              logMsg += '\n    - Appended source link to speaker notes.';
            }
          }

        } else {
          logMsg = `  - WARNING: Slide ${slideInfo.slideId} not found in presentation ${slideInfo.presentationId}.`;
        }
      } catch (e) {
        logMsg = `  - CRITICAL ERROR: Could not process slide from ID '${slideInfo.slideId}'. Skipping. Final Error: ${e.message}`;
        logOutput.push(logMsg);
        return; // Skip to next slide on critical error
      }
      Logger.log(logMsg);
      logOutput.push(logMsg);
    });

    logOutput.push("✅ Generation complete.");
    updateJobStatus(jobId, 'Finalizing presentation...');

    // --- Final Step: Create a status slide with the log output ---
    let statusSlide;
    try {
      statusSlide = activeDeck.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
    } catch (e) {
      logOutput.push('Warning: Predefined layout "TITLE_AND_BODY" not found. Attempting fallback for status slide.');
      let fallbackLayout;
      if (activeDeck.getSlides().length > 0) {
        fallbackLayout = activeDeck.getSlides()[0].getLayout();
      } else {
        fallbackLayout = SlidesApp.PredefinedLayout.BLANK;
      }
      statusSlide = activeDeck.appendSlide(fallbackLayout);
    }

    const statusTitle = statusSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE);
    if (statusTitle) {
      statusTitle.getText().setText("Generation Status");
    }

    const statusBody = statusSlide.getPlaceholder(SlidesApp.PlaceholderType.BODY);
    if (statusBody) {
      statusBody.getText().setText(logOutput.join('\n'));
    } else if (statusTitle) {
      statusTitle.getText().appendText(" (See Logs for Details)");
      Logger.log("Status slide has no BODY placeholder. Full log:\n" + logOutput.join('\n'));
    }

  } catch (e) {
    Logger.log(`Error in generateSlides: ${e.toString()}\n${e.stack}`);
    updateJobStatus(jobId, `ERROR: ${e.message}`);
    
    let errorSlide;
    try {
        // Try the robust TITLE_AND_BODY for the error slide
        errorSlide = activeDeck.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
        errorSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE).getText().setText(`❌ Generation Failed`);
        errorSlide.getPlaceholder(SlidesApp.PlaceholderType.BODY).getText().setText(`Error Message: ${e.message}\n\nCheck the Apps Script Logs for full details.`);
    } catch (layoutError) {
        Logger.log(`Could not use TITLE_AND_BODY for error slide: ${layoutError.message}. Attempting fallback.`);
        let fallbackLayout;
        if (activeDeck.getSlides().length > 0) {
          fallbackLayout = activeDeck.getSlides()[0].getLayout();
        } else {
          fallbackLayout = SlidesApp.PredefinedLayout.BLANK;
        }
        errorSlide = activeDeck.appendSlide(fallbackLayout);
        const errorTitle = errorSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE);
        if (errorTitle) errorTitle.getText().setText(`❌ Generation Failed`);
        const errorBody = errorSlide.getPlaceholder(SlidesApp.PlaceholderType.BODY);
        if (errorBody) errorBody.getText().setText(`Error Message: ${e.message}\n\nCheck the Apps Script Logs for full details.`);
        Logger.log(`Fallback layout used for error slide: ${layoutError.message}`);
    }

    // IMPORTANT: Re-throw the error so that the client-side .withFailureHandler()
    // in the sidebar is triggered, showing the error message to the user.
    throw e;
  }
}